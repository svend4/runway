---
title: "ALG-03: волны платежей"
type: algorithm
status: reviewed
summary: "Жадная кластеризация значимых обязательств по датам (разрыв 3, размах < 10), ручные split/merge/pin и метрики волны: нужно, покрытие, дефицит. Полный псевдокод и тест-векторы на G-001."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/proposal-product.md, wiki/ideas/red-team-critique.md, wiki/decisions/adr-007-payment-waves-clustering.md, wiki/tools/budget-guru.md, wiki/tools/business-cashflow-tools.md]
updated: 2026-10-27
---

# ALG-03 Волны платежей: обнаружение и метрики

## Назначение

Решает вопрос **Q2** из статьи: 25-го разом уходят аренда, ЖКХ и налог, и нужно знать, сколько денег требуется к началу этой «волны», чтобы дожить до следующего поступления с запасом. Алгоритм делает две вещи: (1) собирает значимые обязательства в волны по близости дат; (2) для каждой волны считает «нужно к волне», покрытие и дефицит по физическим деньгам (ряд `trough`).

Реализует [REQ-034](../product/02-requirements.md) (состав), REQ-035 (метрики), REQ-036 (ручные правки), REQ-107 (карточка волны), параметры — гипотезы до калибровки (REQ-188). Идеи: IDEA-09, IDEA-10, IDEA-39 ([предложение по движку](../ideas/proposal-engine.md)). Решение — [ADR-007](../decisions/adr-007-payment-waves-clustering.md); определения D-09, D-10 и §12 X1, X13 из `_ops/design-brief.md`. Понятие — [волны платежей](../concepts/payment-waves.md). Налоговый платёж здесь обычное обязательство пользователя; налоговые числа — расчёт по введённым правилам, не консультация.

## Определения

Термины — по [глоссарию](../product/14-glossary.md). Обозначения: `g = wave.gap_days` (3), `S = wave.max_span_days` (10), `θ = wave.threshold_minor`, `B = buffer_minor`. Все числа примеров — G-001 с **горизонтом 57 дн.** (`as_of` 2026-10-04, `horizon_end` 2026-11-30).

- **Значимое обязательство**: `is_obligation = true`, `is_estimate = false`, `amount_minor < 0`, `|amount_minor| ≥ θ`. Остальное — фон: в состав не входит, но участвует в рядах и в метриках.
- **Волна** — (без ручных правок) непрерывный по порядку отрезок отсортированных обязательств; `start`/`end` — даты первого и последнего; размах `end − start ≤ S − 1`; `total_out_minor = Σ|amount_minor|`.
- **Окно волны** `[start, e_ext]`: `e_ext` — день перед ближайшим поступлением режима после `end`, иначе `horizon_end`.
- Метрики (D-10): `cash_w = close[start − 1]` (при `start = as_of` — `opening`); `R_w = cash_w − min trough` в окне; `need_w = R_w + B`; `gap_w = max(0, B − min trough) = max(0, need_w − cash_w)`; `coverage_pm = floor(1000 · cash_w / need_w)`; `reserved_w = reserve_close[start − 1]` — справочно.
- Именование (X13): `gap_w` — **«дефицит волны (физический)»**; не путать с «не хватает до буфера (с учётом резервов)» из [ALG-11](alg-11-safe-to-spend.md). Порог `θ` по умолчанию (X1, C-022) задаётся при создании рабочей области как `θ = max(30·10^exp, round_div(Σ исходящих posted за 90 дн., 300))` (функция `default_wave_threshold` из `timeline.mjs`, тот же набор исходящих, что у `buffer_hint`; для G-001 `max(3000, 2100) = 3000`); сама функция берёт готовое число из `params`.

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `events` | `CashEvent[]` | эффективные события режима (D-01): `date` — уже эффективная, суммы в валюте решения, без переводов |
| `params.wave` | `{gap_days: int, max_span_days: int, threshold_minor: Minor}` | `g`, `S`, `θ` (`θ ≥ 1`, `S ≥ 1`, `g ≥ 0`, иначе `fail(E_SCHEMA)`) |
| `overrides` | `WaveOverride[]` | `{override_id, action: split\|merge\|pin, event_ids: Id[], pin_range?: {from: EpochDay, to: EpochDay}}`; порядок применения — порядок эффективных записей журнала (`seq`, C-072); поля `recorded_at` у `WaveOverride` нет (C-014) |
| `series` | `Series` + `opening_minor`, `reserve_opening_minor` | ряды режима; `from = as_of`, длина `N` |
| `B` | `Minor` | буфер ≥ 0 |
| `next_income_day` | `EpochDay \| null` | первый приход режима строго после `wave.end` |

| Выход | Тип |
|---|---|
| `Wave` | `{wave_id: string, start: EpochDay, end: EpochDay, event_ids: Id[], total_out_minor: Minor}` |
| `WaveMetrics` | `{window_end: EpochDay, cash_minor, min_trough: {date: EpochDay, amount_minor}, r_minor, need_minor, gap_minor, coverage_pm: int, reserved_minor}` |

`wave_id = 'wave:' + id первого события волны` (порядок — ключ сортировки).

## Алгоритм

```pseudo
# --- 1. состав волн (D-09) ---
is_significant(e, θ) = e.is_obligation и не e.is_estimate и e.amount_minor < 0 и −e.amount_minor ≥ θ

detect_waves(events, params) -> Wave[]:
  g = params.wave.gap_days;  S = params.wave.max_span_days;  θ = params.wave.threshold_minor
  если g < 0 или S < 1 или θ < 1: fail(E_SCHEMA, {param})
  O = [e для e ∈ events если is_significant(e, θ)]
  сортировать O по (e.date, e.amount_minor, e.cash_event_id) по возрастанию   # крупнее — раньше; id — по кодовым точкам
  waves = [];  w = null
  for e in O:
    если w ≠ null и e.date − w.end ≤ g и e.date − w.start < S:               # оба условия
      w.event_ids.push(e.cash_event_id);  w.end = e.date
      w.total_out_minor = assert_minor(w.total_out_minor − e.amount_minor)
    иначе:
      w = { wave_id: 'wave:' + e.cash_event_id, start: e.date, end: e.date,
            event_ids: [e.cash_event_id], total_out_minor: −e.amount_minor }
      waves.push(w)
  return waves

# --- 2. ручные правки: после алгоритма, в порядке эффективных записей журнала (seq; порядок массива overrides, C-014) ---
apply_wave_overrides(waves, overrides, by_id) -> Wave[]:          # by_id: cash_event_id → CashEvent (даты, суммы); split режет волну перед событием, merge объединяет, pin выделяет в отдельную волну
  ws = глубокая копия waves;  known = ∪ w.event_ids по ws       # все значимые обязательства
  for o in overrides:
    ids = [i для i ∈ o.event_ids если i ∈ known]                # остальные ссылки устарели
    если ids пуст: warn(W_OVERRIDE_STALE, o.override_id); continue
    merge: hit = [w ∈ ws если w.event_ids ∩ ids ≠ ∅];  заменить hit одной волной из объединения событий
    split: для каждого i ∈ ids (по ключу сортировки): w = волна с i;
           k = позиция i в w.event_ids;  если k > 0: w → (w[0..k−1], w[k..])       # «режем перед i»
    pin:   M = ids ∪ { i ∈ known : by_id[i].date ∈ o.pin_range } (если pin_range задан)
           убрать M из всех волн (пустые удалить);  ws.push(волна из M)
  для каждой w ∈ ws: события по ключу сортировки; start, end, total_out_minor, wave_id пересчитать
  сортировать ws по (start, wave_id);  return ws

# --- 3. окно и метрики (D-10) ---
next_income_day(events, after) = min{ e.date : e.kind == income, e.amount_minor > 0, e.date > after }  или null

wave_metrics(wave, series, B, next_income_day) -> WaveMetrics:
  horizon_end = series.from + len(series.trough) − 1
  e_ext = next_income_day == null ? horizon_end : max(wave.end, next_income_day − 1)
  i0 = wave.start − series.from;  i1 = e_ext − series.from            # 0 ≤ i0 ≤ i1 < N, иначе fail(E_BAD_DATE)
  cash     = i0 == 0 ? series.opening_minor         : series.close[i0 − 1]
  reserved = i0 == 0 ? series.reserve_opening_minor : series.reserve_close[i0 − 1]
  (m, i_min) = первый argmin series.trough[i0..i1]                     # при равенстве — ранняя дата (D-02)
  r_w = cash − m;   need = r_w + B;   gap = max(0, B − m)
  coverage_pm = mul_div(cash, 1000, need, floor)                       # need ≥ 1: см. инварианты; BigInt внутри
  return { window_end: e_ext, cash_minor: cash, min_trough: {date: series.from + i_min, amount_minor: m},
           r_minor: r_w, need_minor: need, gap_minor: gap, coverage_pm, reserved_minor: reserved }

# --- 4. список для экрана и инструмента list_waves ---
list_waves(ctx, mode) -> [{wave, metrics}]:                       # ctx = Analysis из analyze() (C-012)
  ev = ctx.events[mode];  s = ctx.series[mode]
  B = ctx.buffer_minor ?? 0;  если ctx.buffer_minor = null: warn(W_BUFFER_UNSET)   # C-018: Q1 и волны не блокируются, считают B = 0 с предупреждением
  ws = apply_wave_overrides(detect_waves(ev, ctx.params), ctx.wave_overrides, index_by_id(ev))
  return [ { wave: w, metrics: wave_metrics(w, s, B, next_income_day(ev, w.end)) } для w ∈ ws ]
```

Ключевые решения. **Два условия** (разрыв и размах): цепочка платежей через каждые 3 дня не сливается в бесконечную волну, а режется по размаху. **Фон не соединяет и не разделяет** волны: мелкий платёж не склеивает аренду с налогом. **Окно до следующего прихода** делает `need_w` ответом на вопрос «сколько нужно, чтобы дожить»; фон и приходы окна входят в `trough`, поэтому `R_w` — пиковая просадка, а не сумма волны. **Состав не зависит от режима**: обязательства дат не сдвигают (D-04), различаются окно и метрики. Расчёт идёт по физическим деньгам (`trough`); резервы показываются справочно, чтобы не вычитать их дважды ([ADR-016](../decisions/adr-016-reserves-and-safe-to-spend.md)).

## Инварианты и свойства

1. **Разбиение** (TST-37): каждое значимое обязательство ровно в одной волне; `Σ total_out_minor` = `Σ|amount_minor|` значимых; верно и после `apply_wave_overrides`.
2. Без правок: соседние события волны различаются не более чем на `g` дней, `end − start < S`; следующая волна начинается либо после разрыва `> g`, либо после превышения размаха.
3. Результат не зависит от порядка входного массива событий и волн (порядок записей `overrides` важен: по `seq`); **одиночная** правка идемпотентна — повторное применение к результату ничего не меняет. Для **последовательности** правок это неверно: из четырёх отдельных волн `a, b, c, d` правки `merge{a,b}`, `split{b}`, `merge{a,c}` дают `[a,c]`, `[b]`, `[d]`, а повторный проход по результату — `[a,b,c]`, `[d]` (тест `todo` TST-37); поэтому правки применяются один раз к свежему результату `detect_waves`, а не к уже поправленному.
4. События ниже `θ`, `is_estimate` и расходы без `is_obligation` состав не меняют (локальность).
5. `R_w ≥` расхода дня `start` `> 0`, поэтому `need_w ≥ 1` и деления на ноль нет; `gap_w = max(0, need_w − cash_w)`; `gap_w = 0 ⇔ coverage_pm ≥ 1000`.
6. Окно волны заканчивается на ближайшем поступлении **своего режима** (C-013). Для одного окна `min trough_worse ≤ min trough_plan`; монотонность `need_w` и `gap_w` («в `worse` не лучше `plan`») верна **только** при `next_income_day(worse) ≥ next_income_day(plan)`. Свойства TST-35 для `trough`, `free`, `S_max` безусловны, для `gap_w` и `need_w` — условны (TST-03 проверяет оба случая). Состав в `plan` и `worse` одинаков.
7. Без резервов `reserved_w = 0`; метрики от резервов не зависят.

## Сложность

`detect_waves`: `O(M log M)` по числу событий (сортировка), память `O(M)`. `wave_metrics`: `O(|окно|) ≤ O(N)`; всего `O(W·N)`, при `N ≤ 181`, `W` в единицах — пренебрежимо, дерево отрезков не нужно (C23, REQ-151). Узкое место — только сортировка при очень больших журналах.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Нет значимых обязательств | пустой список, без ошибки | волн нет — это ответ |
| Два обязательства в один день | одна волна; первым идёт более крупное, затем по id | ключ `(date, amount_minor, id)` детерминирован |
| Разрыв ровно `g` / `g + 1` | вместе / раздельно | условие `≤ g` |
| Цепочка через 3 дня: 10-06, 09, 12, 15, 18 | волны `[10-06…10-15]` и `[10-18]` | `10-18 − 10-06 = 12 ≥ S`: режет размах |
| Платёж на сумму `θ − 1` между волнами | фон: не соединяет и не разделяет | порог `θ` включительно |
| Расход без `is_obligation` (гипотеза покупки) | в состав не входит, но уменьшает `trough` и влияет на метрики | покупка — не обязательство |
| Волна начинается в `as_of` (в том числе просроченное обязательство, `eff = as_of`) | `cash_w = opening` | `close[−1] := opening` (D-01) |
| Поступлений после волны нет | окно до `horizon_end` | W2 в G-001 |
| `cash_w < 0` | `coverage_pm` — отрицательное целое (пол); подпись — задача экрана | формула D-10 без обрезки |
| Приход до `wave.end` в `plan` сдвигается после неё в `worse` | окно `worse` может быть короче окна `plan` | следствие определения окна; инвариант 6 с оговоркой (C-013) |
| Правка ссылается на удалённое или ставшее фоном событие | пропускается, предупреждение `W_OVERRIDE_STALE` | правки переживают пересчёт, но не воскрешают события (C-014) |
| Волна у границы горизонта (`end + g > horizon_end`) | состав видимой части; предупреждение `W_WAVE_NEAR_HORIZON` | события за горизонтом в ряд не входят (код — в реестре `vocab.json`, C-021) |
| `buffer_minor` не задан | `B = 0`, предупреждение `W_BUFFER_UNSET`; волны не блокируются | C-018: гейт «нет буфера» относится к Q3 и «можно потратить» |
| `θ` изменён | состав пересчитывается, правки по `event_ids` сохраняются | `θ` — параметр рабочей области |

## Тест-векторы

**TV-1. Состав (синтетика, `θ = 3000`, `g = 3`, `S = 10`).** Обязательства: `o1` 10-06 −5000; `o2` 10-09 −4000; `o3` 10-12 −8000; `o4` 10-15 −3000; `o5` 10-16 −6000; `o6` 10-17 −2999; `o7` 10-30 −7000; `o8` 10-30 −9000. Фон: 10-20 −20000 (без `is_obligation`), 10-21 −15000 (`is_estimate`), 10-22 +9000.
Шаги: `o1`; `o2` (разрыв 3, размах 3) в той же; `o3` (3, 6); `o4` (3, 9 < 10) в той же; `o5`: разрыв 1, но `10-16 − 10-06 = 10 ≥ 10` → новая волна; `o6` (2999 < 3000) — фон; `o8` (−9000 раньше −7000), затем `o7`: разрыв 0.
Результат: `[o1,o2,o3,o4]` 10-06…10-15, `total_out` 20000; `[o5]` 10-16, 6000; `[o8,o7]` 10-30, 16000. Σ = 42000 = 5000+4000+8000+3000+6000+7000+9000 ✓.
Чувствительность (REQ-188): `g = 2` → 5 волн (`o1`, `o2`, `o3`, `[o4,o5]`, `[o8,o7]`); `g = 4` → как при 3; `S = 7` → `[o1,o2,o3]`, `[o4,o5]`, `[o8,o7]`; `S = 13` → `[o1…o5]`, `[o8,o7]`; `θ = 2999` → `[o5,o6]` 10-16…10-17, 8999.

**TV-2. G-001, режимы `plan` и `worse`** (`θ = 3000`, `B = 50000`). Значимые: `P-TAX1` 10-23 (−50000), `R-RENT` и `R-UTIL` 10-26 (−90000, −12000), те же 11-25. Связь −2500 < θ — фон; продукты — оценка. Разрыв 10-23 → 10-26 равен 3 ≤ 3, размах 3 < 10: **W1** `total_out` 152000; **W2** (11-25) 102000.
W1, `plan`: ближайший приход 11-05 → `e_ext = 11-04`; `cash_w = close[10-22] = 377500`; `min trough` 205500 (10-31); `R_w = 377500 − 205500 = 172000`; `need = 172000 + 50000 = 222000`; `gap = max(0, 50000 − 205500) = 0`; `coverage = floor(377500000 / 222000) = 1700`; `reserved = 150000`.
W1, `worse`: приход 11-19 → окно до 11-18; минимум 183000 (11-14); `R = 194500` (+ продукты 11-07, 11-14 и связь 11-09 = 22500); `need = 244500`; `coverage = floor(377500000 / 244500) = 1543`; `gap = 0`.
W2, оба режима: приходов после 11-25 нет → окно до 11-30; `cash_w = 452000`; минимум 340000 (11-28); `R = 112000`; `need = 162000`; `coverage = floor(452000000 / 162000) = 2790`; `reserved = 167800`.

**TV-3. G-001-low** (`opening = 220000`, остальное то же). W1, `plan`: `cash_w = 197500`; минимум 25500 (10-31); `R = 172000`; `need = 222000`; `gap = 50000 − 25500 = 24500 = need − cash`; `coverage = floor(197500000 / 222000) = 889`. `worse`: минимум 3000; `need = 244500`; `gap = 47000`; `coverage = 807`. W2: `cash_w = 272000`, минимум 160000, `need = 162000`, `gap = 0`, `coverage = 1679`. Для `opening = 100000` (G-001-gap): W1 `gap` 144500 / 167000, покрытие 349 / 316; W2 `gap = 10000`, 938.

**TV-4. Ручные правки на G-001.** Идентификатор события — `occ_key` от **номинальной** даты (`R-RENT@2026-10-25` — вхождение, эффективная дата которого 10-26). `merge{P-TAX1, R-RENT@2026-11-25}` даёт одну волну: 254000, `start` 10-23, `end` 11-25; `cash_w = 377500`; окно до 11-30; `plan`: минимум 205500, `need = 222000`, 1700; `worse`: 183000, `need = 244500`, 1543. `split{R-RENT@2026-10-25}` (эффективная дата 10-26) режет W1 на `[P-TAX1]` (50000) и `[R-RENT, R-UTIL]` (102000): вторая в `plan`: `cash_w = close[10-25] = 317500`, `R = 317500 − 205500 = 112000`, `need = 162000`, `coverage = floor(317500000 / 162000) = 1959`, `reserved = 100000` (налог уже высвобожден); в `worse`: `R = 134500`, `need = 184500`, 1720.

**TV-5. Сценарий «дорожка 300,00 € на 10-12».** Состав не меняется; метрики по ряду сценария: W1 `plan`: `cash_w = 347500`, минимум 175500, `R = 172000`, `need = 222000`, `coverage = 1565`; `worse`: минимум 153000, `need = 244500`, 1421.

## Варианты и альтернативы

Календарные корзины (неделя) режут волну границей недели; плотностная кластеризация (класс DBSCAN) зависит от порядка и не объясняется пользователю; фильтр значимости `κ` и «устойчивость» убраны до реальных журналов (C5, [ADR-007](../decisions/adr-007-payment-waves-clustering.md)); формула `need = wave_total + S − B_before` из экрана не учитывает приходы и фон окна (C4). Окно «до поступления» используется только для метрики; состав остаётся жадным, иначе теряется «аренда + ЖКХ + налог».

Другие продукты (только проверенные факты):

| Продукт | Что есть | Что не найдено |
|---|---|---|
| Budget Guru | заявлено: платежи собираются в кластеры, видно «сколько нужно к волне»; правило не раскрыто, приложение не открывалось ([разбор](../tools/budget-guru.md)) | не проверено (не подтверждено) |
| [PocketSmith](../tools/pocketsmith.md) | календарь, bill-категории, напоминания | кластеры и сумма «нужно к дате» |
| [Actual Budget](../tools/actual-budget.md) | расписания попадают в прогноз | метрика «нужно к волне» |
| [Firefly III](../tools/firefly-iii.md) | recurring и subscriptions показывают будущие списания | свёртка по волнам |
| [hledger](../tools/plain-text-accounting.md) | `~`-правила суммируются по периодам | метрика «нужно к волне» (вывод) |
| [Float](../tools/business-cashflow-tools.md) | 13-недельная сетка, низшая точка окна, runway и buffer | расчёт «нужно к волне» (вывод) |

### Не в v1

Значимость `κ`, устойчивость по трём месяцам, автоподбор `g`, `S`, `θ`, календарь волн по истории (v2). Пороги по умолчанию — гипотезы до проверки на ≥ 10 журналах.

## Реализация в прототипе

Статус — **реализовано**: модуль `prototype/engine/waves.mjs` (чистый ES-модуль; импортирует `money`, `dates` и из `timeline` — `get_param`, `normalize_mode`; по слоям §14 B4 стоит выше `sinking`); контекст `ctx` — `Analysis` из `analyze()` (`prototype/engine/index.mjs`, C-012). Сверка с кодом и прогон тест-векторов TV-1…TV-5 — 2026-10-04: числа сходятся (состав `[o1…o4]`, `[o5]`, `[o8, o7]` и чувствительность к `g`, `S`, `θ`; W1/W2 G-001 в `plan` и `worse`; G-001-low и G-001-gap; `merge`/`split`; дорожка 300,00 €). Реальные сигнатуры:

```js
detect_waves(events, params) -> Wave[]
apply_wave_overrides(waves, overrides, by_id) -> Wave[]
apply_wave_overrides_ex(waves, overrides, by_id) -> {waves, warnings: [{code: 'W_OVERRIDE_STALE', override_id, event_ids}]}
next_income_day(events, after) -> EpochDay | null          // экспорт принят каноном (C-021)
wave_metrics(wave, series, B, next_income_day) -> WaveMetrics
list_waves(ctx, mode) -> [{ wave, metrics }]
list_waves_ex(ctx, mode) -> {items: [{ wave, metrics }], warnings}   // W_BUFFER_UNSET, W_OVERRIDE_STALE, W_WAVE_NEAR_HORIZON
```

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1: `waves.mjs` совпадает со снимком от 2026-10-05 построчно (в модуле после сверки ничего не менялось), числа G-001 прежние. Вокруг ядра появились надстройки и экраны. Движок: `engine/wave_sweep.mjs` (FP-07, REQ-036; из `index.mjs` не реэкспортируется) — `sweep_waves` (таблица чувствительности: тот же `detect_waves` при других `θ`, `g`, `S`, до 200 строк), `candidate_thetas`, `explain_membership` и `explain_boundary` («почему платежи в одной волне», «почему эти две волны разделены»), `wave_origin`, `stale_overrides`. Демо: на экране «Волны» у каждой карточки кнопки «Почему так» и «Править волну» (слот `waves.card`, S1.5); правки волн (объединить, разделить, закрепить платёж) идут общим путём записи с «Отменить» (`wave_edit.mjs`); диалог «Почему волна N» заканчивается строкой «числа из расчёта c_… · движок · режим · inputs…» и блоком «Что было бы без…» (первые три группы платежей, полный пересчёт `analyze` с `remove_flow`; `why_more.mjs`, FP-47); список волн считается в Web Worker с откатом на главный поток (FP-21). **Не реализовано:** значимость κ, устойчивость по трём месяцам, автоподбор `g`, `S`, `θ` (v2) и калибровка по журналам добровольцев (REQ-188): пороги по умолчанию остаются гипотезами, отчёт `tools/backtest_report.mjs` на синтетике даёт нулевую чувствительность волн. **Открытый `todo`:** `adversarial/semantics`, TST-37 — идемпотентность верна для одиночной правки, но не для последовательности правок (страница исправлена, решение — за арбитром канона).

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; номера TST — по [стратегии тестирования](../product/11-testing-strategy.md); в скобках число тестов файла):

| Файл | Что покрывает |
|---|---|
| `prototype/tests/waves.test.mjs` (26) | TST-03: TV-1 (состав, чувствительность `g`/`S`/`θ`), граничные случаи, G-001 (состав, метрики W1/W2 в `plan` и `worse`, окно «до своего прихода» C-013 — случаи 1 и 2), `wave_metrics`, `next_income_day`, `list_waves`, TV-5; TST-08: G-001-low и G-001-gap; TST-37: TV-4 (`merge`, `split`), `pin`, порядок по `seq`, `W_OVERRIDE_STALE`, правки в `Analysis`, свойства на 10³ случаев (разбиение, идемпотентность одиночной правки) |
| `prototype/tests/g001.golden.test.mjs` (10) | ключи `G-001.waves.*` (§9.5) через `analyze` и `list_waves` |
| `prototype/tests/analyze.test.mjs` (18) | порог `θ` по умолчанию, `gap_days = 2` → три волны, `wave_overrides` в `Analysis` |
| `prototype/tests/adversarial/semantics.test.mjs`, `prototype/tests/adversarial/golden_properties.test.mjs` | состязательные: границы `g`, `S`, `θ`, фон, порядок в один день, окно и метрики (приход на следующий день, после горизонта, `cash_w < 0`), `W_WAVE_NEAR_HORIZON`, случайные последовательности правок, оракул волн на случайных данных (B-42, B-43, B-67); один `todo` — инвариант 3 для последовательности правок (исправлен на странице) |
| `prototype/tests/properties.test.mjs` (13), `properties_mutation.test.mjs` (10) | FP-24: инвариант TST-37 (каждое значимое обязательство ровно в одной волне, Σ `total_out` равна сумме обязательств, `split` / `merge` / `pin` ведут себя как заявлено, повтор той же правки ничего не меняет, ссылка на исчезнувшее событие — `W_OVERRIDE_STALE`) на 1000 журналах общего генератора и красный результат на подменах |
| `prototype/tests/wave_edit.test.mjs` (12), `why_more.test.mjs` (12), `waves_card.test.mjs` (22), `s1_5_adv.test.mjs` (17), `why_dialogs_full.test.mjs` (14) | `wave_sweep`, правки волн с «Отменить», «Почему» волны (сумма строк равна пиковой просадке окна), кнопки на карточке волны (слот `waves.card`), номер расчёта и контрфакты в диалоге (FP-07, S1.5, FP-47) |

**Расхождения «псевдокод ≠ код»** (смысл совпадает; код прототипа не менялся; багов кода не найдено):

1. Предупреждения. `apply_wave_overrides` и `list_waves` возвращают только `Wave[]` и `[{wave, metrics}]` (как в каноне), а `W_OVERRIDE_STALE`, `W_BUFFER_UNSET`, `W_WAVE_NEAR_HORIZON` отдают парные `_ex` — тот же приём, что `build_events` / `build_events_ex`; `analyze` собирает их в `Analysis.warnings`.
2. `W_OVERRIDE_STALE` — `{code, override_id, event_ids}` со списком устаревших ссылок: выдаётся и когда устарела часть `event_ids` (известные применяются), а не только когда пуст весь список; `pin` без событий и без попавших в `pin_range` — предупреждение с пустым `event_ids`.
3. `params` — плоские ключи `wave.gap_days`, `wave.max_span_days`, `wave.threshold_minor` или вложенный `params.wave` (`get_param`); значения — safe-integer (`g ≥ 0`, `S ≥ 1`, `θ ≥ 1`), иначе `E_SCHEMA`, в том числе когда параметр не задан.
4. Порядок правок — по `seq`, если он есть у всех записей, иначе порядок массива. `apply_wave_overrides_ex` бросает `E_SCHEMA` на неизвестном действии, `event_ids` не массиве и событии волны, которого нет в `by_id`; `by_id` — `Map`, объект или массив событий; даты — `IsoDate` или `EpochDay`.
5. `wave_metrics`: поступление позже горизонта считается отсутствующим (окно до `horizon_end`); `reserve_close` и `reserve_opening_minor` необязательны (нет — `reserved_minor = 0`); `B < 0` и `need_w < 1` (волна не согласована с рядом) — `E_SCHEMA`, волна вне ряда — `E_BAD_DATE`.
6. `list_waves_ex`: режим `conservative` = `worse`; нет рядов или событий режима в `ctx` — `E_SCHEMA`; ручные правки берутся из `ctx.wave_overrides` (в `analyze` уже упорядочены по `seq`).
7. Исправлено на странице (не в коде): инвариант 3 — идемпотентность верна только для одиночной правки; в TV-4 идентификаторы событий — `occ_key` от номинальной даты (`R-RENT@2026-10-25`, а не `R-RENT@10-26`).

## Связанные страницы

- [ADR-007 волны платежей](../decisions/adr-007-payment-waves-clustering.md), [волны платежей (понятие)](../concepts/payment-waves.md)
- [ALG-02 временная шкала](alg-02-timeline-projection.md), [ALG-04 «могу ли я купить»](alg-04-can-i-afford.md), [ALG-11 safe-to-spend](alg-11-safe-to-spend.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [Budget Guru](../tools/budget-guru.md)
