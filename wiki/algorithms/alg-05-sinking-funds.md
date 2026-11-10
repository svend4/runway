---
title: "ALG-05: sinking funds — взносы на редкие траты"
type: algorithm
status: reviewed
summary: "Амортизация годовых и полугодовых трат: ceil-взносы, догон при пересчёте, режимы refill_to_target и fixed, пул по наибольшим остаткам; псевдокод и тест-векторы на G-001."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/proposal-product.md, wiki/decisions/adr-016-reserves-and-safe-to-spend.md, wiki/tools/ynab.md, wiki/tools/actual-budget.md, wiki/tools/firefly-iii.md, wiki/tools/plain-text-accounting.md, wiki/tools/pocketsmith.md]
updated: 2026-10-27
---

# ALG-05 Sinking funds

## Назначение

Годовая страховка, отпуск или подарки «выстреливают» одним платежом и ломают прогноз, который выглядел достаточным. Алгоритм превращает цель «60 000 minor к 15 марта» в расписание небольших **взносов** по датам и отдаёт их как виртуальные аллокации в резерв: деньги не двигаются, `close` и `trough` не меняются, но свободный остаток `free` уменьшается заранее ([ADR-016](../decisions/adr-016-reserves-and-safe-to-spend.md), D-07, D-18). Вопросы: Q3 («можно потратить» и вердикты считаются по `free`, [ALG-04](alg-04-can-i-afford.md), [ALG-11](alg-11-safe-to-spend.md)) и общий учёт резервов.

Реализует REQ-060, REQ-069, REQ-070, REQ-071 ([требования](../product/02-requirements.md)); идеи IDEA-21 и IDEA-41 ([движок](../ideas/proposal-engine.md), [продукт](../ideas/proposal-product.md)); решение X3 из `_ops/design-brief.md` §12. Понятие — [sinking funds](../concepts/sinking-funds.md). Ряд резервов `reserve_series` и `free_series` описаны полностью в [ALG-11](alg-11-safe-to-spend.md); эта страница отвечает за **расписание** взносов.

## Определения

- **Цель** `target_minor`, **накоплено на начало `as_of`** `funded_open_minor` — результат `reserve_open(reserve, recorded_allocations, as_of) = max(0, funded_start_minor + Σ записанных аллокаций с funded_as_of < date ≤ as_of)` (в том числе по `posted`-доходу на `as_of`; остаток не ниже 0 — D-08; C-020), **срок** `due_date` — день платежа, привязанного к резерву через `reserve_id`. `funded_start_minor` + `funded_as_of` — хранимое состояние резерва, `funded_open_minor` — его проекция для движка.
- **Даты взносов** `dates` — даты правила `cadence` (по умолчанию `{freq: M, day: 1}`) на полуинтервале `as_of ≤ d < due_date`; `n = len(dates)`. Срок в число дат не входит: взнос в день платежа бессмыслен.
- **Остаток к накоплению** `rem_0 = target_minor − funded_open_minor`; взнос `c_k = min(ceil_div(rem_k, n − k), rem_k)`, `rem_{k+1} = rem_k − c_k`, `k = 0..n−1` (D-18).
- Режим `refill_to_target` («до цели»): расписание пересчитывается от текущего `funded_open_minor` при каждом запросе — это и есть **догон**. `Reserve.mode` обязателен только при `kind = sinking`, `due_date` — при `refill_to_target` (C-020).
- Плановые взносы в журнал **не пишутся автоматически** (C-030): `funded_open_minor` растёт только от записанных аллокаций (`allocation.recorded`, `source = schedule`); пока взносы за прошедшие даты не подтверждены, интерфейс показывает `W_RESERVE_BEHIND` («взносов не подтверждено: N на сумму X»). Частота взносов в v1 — только `M`. Режим `fixed` («фикс»): взнос `fixed_minor` задан пользователем, цель может не достигаться, разница — `shortfall_minor`.
- **Пул**: общая сумма на несколько целей делится по весам (обычно `c_0` каждой цели) методом наибольших остатков.
- Названия режимов Runway независимы от одноимённых режимов YNAB и Actual: у YNAB есть отдельная семантика «Refill up to», у Actual — Refill to Cap ([YNAB](../tools/ynab.md), [Actual](../tools/actual-budget.md)).

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `target_minor`, `funded_open_minor` | `amount_minor: int` | в валюте решения (X4; проверка валюты — при `reserve.set` и `build_events`, не в функциях этой страницы, C-098); `funded_open_minor` — состояние на начало `as_of` после `reserve_open` (все записанные аллокации ≤ `as_of`) |
| `recorded_allocations`, `recorded_ids` | `Allocation[]`, `Id[]` | записанные аллокации резерва; `allocation_id` уже записанных (идемпотентность расписания, C-020) |
| `start`, `due`, `cadence`, `cal` | `date: EpochDay`, `{freq, day, weekend?}`, `Calendar` | `start = as_of`; `due` — верхняя граница, не включается; `freq = M` (C-030) |
| `mode` | `refill_to_target \| fixed` | как в `Reserve.mode` |
| `fixed_minor?` | `amount_minor: int` | только для `fixed` |
| `weights`, `total` | `int[]`, `int` | для пула |

| Выход | Тип |
|---|---|
| `contribution_dates` | `EpochDay[]` (по возрастанию, без повторов) |
| `contribution_plan` | `[{date: EpochDay, amount_minor: int}]`, только `amount_minor > 0` |
| `plan_status` | `{status: ok \| reached \| no_dates, shortfall_minor}` |
| `contribution_plan_fixed` | `{rows[], shortfall_minor, reached_on: EpochDay \| null}` |
| `reserve_open` | `Minor` — `funded_open_minor` для `reserve_series` (C-020, C-031) |
| `contribution_allocations` | `Allocation[]` с `source = schedule`, `date ≥ as_of`, без уже записанных `allocation_id` — вход `reserve_series` |

## Алгоритм

```pseudo
contribution_dates(start, due, cadence, cal) -> EpochDay[]:        # start ≤ d < due
  если cadence.freq ≠ 'M' или не (1 ≤ cadence.day ≤ 31): fail(E_SCHEMA)
  (y, m, _) = civil_from_days(start);  t0 = y·12 + (m − 1);  out = []
  for j in 0..:
    ty = floor_div(t0 + j, 12);  tm = floor_mod(t0 + j, 12) + 1
    nom = days_from_civil(ty, tm, clamp_day(ty, tm, cadence.day))   # от исходного day, без дрейфа
    если nom ≥ due: break                                            # номинальные даты растут монотонно
    d = shift_by_policy(nom, cadence.weekend ?? 'keep', cal)
    если d ≠ null и start ≤ d < due: out.push(d)
  return sorted_unique(out)

reserve_open(reserve, recorded_allocations, as_of) -> Minor:      # funded_open (C-020)
  s = reserve.funded_start_minor
      + Σ a.amount_minor для a ∈ recorded_allocations                # все source, со знаком (release, manual − тоже)
          если a.reserve_id == reserve.reserve_id и reserve.funded_as_of < a.date ≤ as_of
  return max(0, s)                                                   # D-08: остаток резерва не бывает отрицательным

contribution_plan({target_minor, funded_open_minor, dates, mode}) -> [{date, amount_minor}]:
  если mode ∉ {null, refill_to_target}: fail(E_SCHEMA)               # функция строит только график «до цели»; fixed — contribution_plan_fixed
  rem = target_minor − funded_open_minor;  n = len(dates)
  если rem ≤ 0 или n == 0: return []                 # X3: без деления на ноль и без исключения
  rows = []
  for k in 0..n−1:
    c = min(ceil_div(rem, n − k), rem)               # ceil: сумма сходится ровно, разброс ≤ 1 minor
    если c > 0: rows.push({ date: dates[k], amount_minor: c })
    rem −= c
  return rows

plan_status({target_minor, funded_open_minor, dates}) -> {status, shortfall_minor}:
  rem = target_minor − funded_open_minor
  если rem ≤ 0:        return { status: 'reached',  shortfall_minor: 0 }
  если len(dates) == 0: return { status: 'no_dates', shortfall_minor: rem }   # UI: «нет дат взноса до срока»
  return { status: 'ok', shortfall_minor: 0 }

contribution_plan_fixed({funded_open_minor, fixed_minor, dates, target_minor}) -> {rows, shortfall_minor, reached_on}:
  если fixed_minor < 0: fail(E_SCHEMA)
  rem = target_minor == null ? null : target_minor − funded_open_minor        # null — цель не задана, без потолка
  rows = []
  for d in dates:
    если rem ≠ null и rem ≤ 0: break
    c = rem == null ? fixed_minor : min(fixed_minor, rem)                # не переполняем цель
    если c > 0: rows.push({ date: d, amount_minor: c }); если rem ≠ null: rem −= c
  shortfall = rem == null ? 0 : max(0, rem)
  reached_on = (shortfall == 0 и rows ≠ []) ? last(rows).date : null
  return { rows, shortfall_minor: shortfall, reached_on }

periods_to_goal(rem, fixed_minor) = fixed_minor == 0 ? null : (rem ≤ 0 ? 0 : ceil_div(rem, fixed_minor))    # справочно

pool_split(total, weights) -> int[]:
  если Σ weights == 0: return [0 для каждого]        # все цели достигнуты; остаток пула решает пользователь
  return split_largest_remainder(total, weights)

contribution_allocations(reserve, funded_open_minor, as_of, horizon_end, cal, recorded_ids) -> Allocation[]:
  если reserve.kind ≠ 'sinking': fail(E_SCHEMA)
  если reserve.mode ∉ {refill_to_target, fixed}: fail(E_SCHEMA)                    # C-020: mode обязателен при kind = sinking
  если reserve.mode == refill_to_target и reserve.due_date == null: fail(E_SCHEMA)
  если reserve.mode == fixed и reserve.fixed_minor == null: fail(E_SCHEMA)
  due = reserve.due_date ?? horizon_end + 1
  all = contribution_dates(as_of, due, reserve.cadence ?? {freq: 'M', day: 1}, cal)      # даты ≥ as_of и до срока, а не до горизонта
  id_of(d) = 'sch:' + reserve.reserve_id + '@' + format_date(d)
  dates = [ d для d ∈ all если id_of(d) ∉ recorded_ids ]       # уже записанные взносы учтены в funded_open: не дублируем (C-020)
  rows = reserve.mode == refill_to_target
         ? contribution_plan({target_minor: reserve.target_minor, funded_open_minor, dates, mode: reserve.mode})
         : contribution_plan_fixed({funded_open_minor, fixed_minor: reserve.fixed_minor, dates, target_minor: reserve.target_minor}).rows
  return [ { allocation_id: id_of(r.date), reserve_id: reserve.reserve_id,
             date: r.date, amount_minor: r.amount_minor, source: schedule }
           для r ∈ rows если r.date ≤ horizon_end ]    # обрезка по горизонту после расчёта: суммы не меняются
```

Решения. **Ceil, а не округление к ближайшему**: сумма сходится ровно без «поправки в последнем взносе», а крупнее на 1 minor — ранние взносы (резерв растёт не медленнее линейного). **`n` считается до срока**, а не до горизонта: размер взноса зависит от всего срока, обрезаются только строки. **Догон без отдельного кода**: пропущенный взнос или ручная правка меняют `funded_open_minor`, а пересчёт от текущего состояния растягивает недостачу на оставшиеся даты. **Взносы не пишутся автоматически (C-030):** движок не выдумывает факты — `funded_open_minor` растёт только от записанных аллокаций (`source = schedule`); подтверждение пакетом («подтвердить взносы за период») — одно действие интерфейса, до него показывается `W_RESERVE_BEHIND` («взносов не подтверждено: N на сумму X»), а в `Result` попадает только записанное (резерв занижен, `free` завышен — это осознанный компромисс, решение арбитра C-030, `_ops/canon-decisions.md`). **Идемпотентность:** будущие аллокации — только `date ≥ as_of` и без тех, чей `allocation_id` уже записан; уже записанные взносы входят в `funded_open_minor` и в число дат не попадают. При платеже в `due_date` резерв высвобождается по правилам [ALG-06](alg-06-tax-envelope.md) и [ALG-11](alg-11-safe-to-spend.md): превышение — `true_up` на свободные деньги; **неиспользованный остаток остаётся в резерве до ручной отрицательной аллокации** (`source = manual`, действие «освободить остаток», C-059): интерфейс показывает `W_RESERVE_RESIDUAL`, автоматического освобождения нет (консервативно: `free` не завышается). Резерв с прошедшим `due_date` без привязанного платежа — `W_RESERVE_OVERDUE`.

## Инварианты и свойства

1. При `rem_0 > 0`, `n ≥ 1`: `Σ amount_minor = rem_0`.
2. Суммы по датам не возрастают, разница между любыми двумя (с учётом отброшенных нулей) не больше 1 minor.
3. **Оракул:** суммы совпадают с `split_equal(rem_0, n)` без нулей (первым датам — лишние minor).
4. Идемпотентность догона: если все взносы записаны по плану, пересчёт от состояния `funded_open_k` на любой дате даёт тот же «хвост» расписания; повторный вызов `contribution_allocations` с теми же `recorded_ids` не дублирует записанные взносы (C-020).
5. Монотонность: рост `target_minor` или падение `funded_open_minor` не уменьшает ни один взнос.
6. `fixed`: `funded_open + Σ rows + shortfall = target`; ни один взнос не превышает `fixed_minor`; `funded_open + Σ rows ≤ target`.
7. Обрезка по горизонту не меняет суммы; даты строго возрастают и лежат в `[as_of, due)`.
8. `pool_split`: `Σ = total`, каждая доля отличается от точной пропорциональной меньше чем на 1 minor.
9. Взносы не меняют `close` и `trough`; `free` уменьшается ровно на накопленный резерв (TST-02).

## Сложность

`contribution_dates`, `contribution_plan`, `contribution_plan_fixed` — `O(n)` по времени и памяти (`n` — число месяцев до срока, на практике ≤ 60); `pool_split` — `O(G log G)` по числу целей; `contribution_allocations` — `O(n)` на резерв. Деление — на целых, BigInt не нужен (суммы в safe-integer). Узких мест нет; полный пересчёт при каждом изменении допустим.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| `target ≤ funded_open` | пустой график, `status = reached` | `rem ≤ 0` (X3, REQ-071) |
| Нет дат до срока, `rem > 0` | пустой график, `shortfall = rem`, `no_dates`, без исключения | цель 600,00 € при сроке 2026-10-20 и взносе 1-го: ближайшая дата 11-01 уже после срока |
| `due ≤ as_of` | как «нет дат» | полуинтервал пуст |
| `rem < n` | `rem` взносов по 1 minor, остальные нули не выводятся | `ceil_div` даёт [1,1,1,0,0] для `rem = 3`, `n = 5` |
| `n = 1` | один взнос на всю сумму | `ceil_div(rem, 1) = rem` |
| `refill_to_target` без `due_date` | `fail(E_SCHEMA)` | делить не на что; есть режим `fixed` |
| `cadence.day = 31` | февраль — 28/29, остальные месяцы без дрейфа | `clamp_day` от исходного дня |
| `as_of` совпал с датой взноса | взнос входит в день 0 | план на `as_of` ещё «впереди» (D-01) |
| Пропущенный (не подтверждённый) взнос или ручной перевод | пересчёт от текущего `funded_open`; пока взносы за прошедшие даты не записаны — `W_RESERVE_BEHIND` | догон = пересчёт; взносы автоматически не пишутся (C-030) |
| Взнос на дату `as_of` уже записан | в `funded_open`, в число дат расписания не входит | идемпотентность по `allocation_id` (C-020) |
| Платёж в срок, в резерве остаток | остаток остаётся, `W_RESERVE_RESIDUAL`; освобождение — только ручной отрицательной аллокацией | C-059 |
| `due_date` прошёл, платёж не привязан | `W_RESERVE_OVERDUE` | C-059 |
| Записанная `manual`/`release`-аллокация больше накопленного | `funded_open = 0`, излишек отбрасывается; расчёт не падает | D-08: остаток резерва не бывает отрицательным |
| `fixed_minor` больше остатка | последний взнос урезан, остальные даты без строк, `reached_on` — дата последней строки | потолок цели |
| `fixed_minor = 0` | строк нет, `shortfall = rem` | `periods_to_goal = null` |
| `funded_open > target` | `reached`, отрицательных взносов нет | возврат излишка — ручная аллокация (v1) |
| Сумма весов пула 0 | нули | все цели достигнуты |
| Валюта резерва ≠ валюте решения | `E_CURRENCY_MISMATCH` при `reserve.set` (и при `build_events` для событий); внутри функций этой страницы и `reserve_series` проверки нет | X4, C-098 |
| `cadence.freq ≠ M` | `fail(E_SCHEMA)` | в v1 только `M` (C-030) |

## Тест-векторы

**TV-1. Страховка G-001 (TST-20), горизонт 57 дн.** Цель 60000, `funded = 0`, `due = 2027-03-15`, `as_of = 2026-10-04`. Даты: 2026-11-01, 12-01, 2027-01-01, 02-01, 03-01 (10-01 раньше `as_of`, 04-01 после срока), `n = 5`. `ceil_div(60000, 5) = 12000` на каждом шаге, `rem` = 60000 → 48000 → 36000 → 24000 → 12000 → 0. Итог `[12000 ×5]`, Σ 60000. В горизонте 57 дн. попадает только 2026-11-01: `reserve_trough = 100000 + 12000 = 112000` (после высвобождения налога 10-23), `free = 205500 − 112000 = 93500` — минимум `plan` из таблицы G-001.

**TV-2. Отпуск (TST-21).** Цель 180000, `funded = 9500`, `due = 2027-07-01`, `rem_0 = 170500`, `n = 8` (11-01 … 2027-06-01):

| `k` | Дата | `rem_k` | `n − k` | `c_k` |
|---:|---|---:|---:|---:|
| 0 | 2026-11-01 | 170500 | 8 | 21313 |
| 1 | 2026-12-01 | 149187 | 7 | 21313 |
| 2 | 2027-01-01 | 127874 | 6 | 21313 |
| 3 | 2027-02-01 | 106561 | 5 | 21313 |
| 4 | 2027-03-01 | 85248 | 4 | 21312 |
| 5 | 2027-04-01 | 63936 | 3 | 21312 |
| 6 | 2027-05-01 | 42624 | 2 | 21312 |
| 7 | 2027-06-01 | 21312 | 1 | 21312 |

`[21313 ×4, 21312 ×4]`, Σ = 85252 + 85248 = 170500 = `split_equal(170500, 8)`. Рядом день рождения: цель 25000, `funded = 4000`, 5 периодов → `[4200 ×5]`. На 2026-11-01 сумма взносов `12000 + 4200 + 21313 = 37513`. Пул 37500 по весам `[12000, 4200, 21313]`: точные доли 11995,84 / 4198,54 / 21305,61 → базы `[11995, 4198, 21305]`, остаток 2 уходит двум наибольшим дробным частям (индексы 0 и 2): `[11996, 4198, 21306]`, Σ 37500 (на 13 minor меньше потребности).

**TV-3. Догон.** Отпуск, взнос 2027-01-01 не записан: `funded_open = reserve_open = 9500 + 21313 + 21313 = 52126` (`funded_start = 9500` и записанные аллокации 11-01 и 12-01), `as_of = 2027-01-02`. Даты: 02-01 … 06-01, `n = 5`, `rem = 127874`. Взносы `[25575 ×4, 25574]`: 25575, 25575, 25575, 25575, 25574 (Σ 127874). Первый взнос вместо плановых 21313 больше на 4262. До подтверждения интерфейс показывает `W_RESERVE_BEHIND`: «взносов не подтверждено: 1 на сумму 21313» (C-030). **TV-3b (идемпотентность, C-020).** Тот же отпуск, `as_of = 2026-12-01`, аллокация `sch:<reserve_id>@2026-11-01` записана: `funded_open = 9500 + 21313 = 30813`, `recorded_ids = {sch:…@2026-11-01}`; даты ≥ `as_of`: 12-01 … 06-01 (7 дат, ни одна не записана), `rem = 149187` → `[21313 ×3, 21312 ×4]`, Σ 149187 — то же «хвостовое» расписание, что в TV-2 (строки `k = 1…7`), запись 11-01 не повторяется.

**TV-4. `fixed` (TST-22).** Отпуск, `funded_open = 9500`, `fixed_minor = 15000`, 8 дат: `9500 + 8 · 15000 = 129500`, `shortfall = 180000 − 129500 = 50500` (505,00 €); `periods_to_goal(170500, 15000) = 12`; для сравнения нужный взнос по режиму до цели — 21313. При `fixed_minor = 30000`: строки `[30000 ×5, 20500]`, `reached_on = 2027-04-01`, `shortfall = 0`.

**TV-5. Краевые.** Цель 60000, `funded_open = 0`, `due = 2026-10-20`, `as_of = 2026-10-04`: `dates = []`, `plan_status = {no_dates, 60000}`, исключения нет. Цель 60000 при `funded_open = 60000`: `[]`, `reached`. `rem = 3`, `n = 5`: `[1, 1, 1]`.

## Варианты и альтернативы

Рассмотрены: округление к ближайшему (сумма не сходится, нужна поправка в хвосте), `floor` с остатком в последнем взносе (хвост тяжелее), ежедневное начисление (нет «ступенек» взносов, плохо ложится на ручной ввод). Выбран `ceil` по месяцам, потому что совпадает с `split_equal` и проверяется оракулом.

| Продукт | Что есть | Что не найдено |
|---|---|---|
| [YNAB](../tools/ynab.md) | Targets: недельные, месячные, годовые, свои сроки; режимы «Set aside another», «Refill up to», «Have a balance of»; недофинансирование подсвечивается | пул целей и догон как свойство расписания; слой прогноза |
| [Actual Budget](../tools/actual-budget.md) | автоматизации Save by Date и Refill to Cap (экспериментальные) | правило округления взноса (не подтверждено) |
| [Firefly III](../tools/firefly-iii.md) | piggy banks — метка внутри счёта; в модели `target_date`, `save_per_month` (по исходникам) | автоматические регулярные взносы |
| [PocketSmith](../tools/pocketsmith.md) | rollover-бюджеты (beta); справка не рассчитывает продукт на конверты | расписание взносов |
| [hledger](../tools/plain-text-accounting.md) | виртуальные субсчета-конверты | отдельная функция sinking fund; у Fava годовой бюджет делится на дневной эквивалент |
| Budget Guru | заявлено только статьёй автора; алгоритм не показан (не подтверждено) ([разбор](../tools/budget-guru.md)) | не проверено |

### Не в v1

Привязка резерва к реальному счёту (v1.1, REQ-191); бюджет слоями и резервы в нём (IDEA-41, v1.1); другие частоты взноса, кроме месячной (в v1 и в прототипе только `freq = M`, C-030); автозапись плановых взносов в журнал (отклонена, C-030); автоматическое освобождение остатка резерва после платежа (отклонено, C-059); процент от дохода как взнос — не планируется в v1.

## Реализация в прототипе

**Статус: реализовано** (сверка с кодом 2026-10-04). Модуль `prototype/engine/sinking.mjs` (зависит от `money`, `dates`; чистый: ни часов, ни ввода-вывода); там же `reserve_series` и `free_series` по [ALG-11](alg-11-safe-to-spend.md). Реализованы все функции страницы; тест-векторы TV-1…TV-5 воспроизводятся движком до minor (прогон `node` на `prototype/engine/index.mjs`, цифры G-001 — через `analyze` на `prototype/data/g001.json`).

```js
contribution_dates(start, due, cadence, cal?) -> EpochDay[]                // start/due — EpochDay или IsoDate; без cal — календарь без выходных
contribution_plan({ target_minor, funded_open_minor, dates, mode? }) -> [{ date, amount_minor }]   // нулевые строки опущены; mode, если задан, только 'refill_to_target'
plan_status({ target_minor, funded_open_minor, dates }) -> { status, shortfall_minor }    // вспомогательная (C-031)
contribution_plan_fixed({ funded_open_minor, fixed_minor, dates, target_minor? }) -> { rows, shortfall_minor, reached_on }   // target_minor null/не задан — без потолка
periods_to_goal(rem, fixed_minor) -> int | null                                            // вспомогательная (C-031)
pool_split(total, weights) -> int[]
reserve_open(reserve, recorded_allocations, as_of) -> Minor                                // C-020, C-031; не ниже 0
reserve_open_ex(reserve, recorded_allocations, as_of) -> { funded_open_minor, ignored: [{ allocation_id, reason: 'future' | 'before_funded_as_of' }], clipped_minor }   // Q-20, К-13; reserve_open — его обёртка, числа прежние
contribution_allocations(reserve, funded_open_minor, as_of, horizon_end, cal, recorded_ids) -> Allocation[]   // C-020, C-031; recorded_ids — любой Iterable
reserve_series(reserves, events, allocations, as_of, horizon_end) -> { reserve_trough, reserve_close, by_reserve }   // ALG-11
free_series(trough, reserve_trough) -> int[]                                               // ALG-11
```

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1; числа G-001 и ряды `reserve_series` / `free_series` прежние. Что изменилось в движке: `sinking.mjs` — `contribution_dates` идёт от месяца, предшествующего `start` (номинал предыдущего месяца, сдвинутый `weekend = next` в окно, больше не теряется; Q-18, К-11), добавлена `reserve_open_ex` (отброшенные записи и обрезанный излишек не молчаливы; Q-20), у `refill_to_target` без `target_minor` отказ — `E_SCHEMA` с причиной `target_missing` (Q-29); `analyze` (`index.mjs`) кладёт в `W_RESERVE_BEHIND` числа `missed_count` и `missed_minor` (Q-09: для `fixed` — `fixed_minor × число`, для `refill_to_target` — первые строки графика от текущего накопленного). Надстройки (из `index.mjs` не реэкспортируются): `engine/sinking_report.mjs` (FP-08, REQ-069…071: `sinking_plan`, `reserve_behind_detail` — те же числа, что несёт предупреждение, `confirm_rows` — пакетное подтверждение взносов записями `allocation.recorded` с `allocation_id = sch:<reserve_id>@<дата>`, повтор безвреден; `pool_split_report`; «цель достигнута» и «до срока нет дат взноса» без исключений) и `engine/transfer_guard.mjs` (FP-04, REQ-063: перевод на копилку при резерве без привязки к счёту — вопрос о двойном вычитании). Демо: форма «Накопления» с планом взносов и «N на сумму X» (`form_sinking.mjs`, FP-08; плашка «Взносов не подтверждено: N на сумму X»); плашки `W_RESERVE_RESIDUAL` и `W_RESERVE_OVERDUE` теперь называют сумму остатка, а кнопка «Освободить остаток» (ручная запись `source = manual` с обратным знаком, одна запись — одна единица «Отменить») стоит в плашке и в карточке резерва на экране «Резервы»; там же «Как посчитано» (FP-15, `reserve_release.mjs`, `alloc_explain.mjs`). **Не реализовано:** частоты взноса кроме месячной (в v1 `freq = M`, C-030), автозапись плановых взносов (отклонена, C-030), автоматическое освобождение остатка после платежа (отклонено, C-059), бюджет слоями (IDEA-41). Привязка резерва к счёту (REQ-191) в движке есть (`backed_by_account_id`), но не доведена: критерий «перевод суммы резерва оставляет `free` прежним» выполняется для перевода всей суммы, перевод меньшей суммы поднимает `free` на разницу, селектора «Хранится на счёте» в интерфейсе нет — характеризующие тесты `reserve_backing_free`, решение по D-07 за владельцем (FP-35).

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; в скобках число тестов файла):

- `prototype/tests/sinking.test.mjs` (29 тестов). Под ALG-05: TST-20 (TV-1, в том числе G-001 в горизонте 57 дн.: одна аллокация 12000 на 2026-11-01), TST-21 (TV-2, день рождения, пул, догон, TV-3, TV-3b, `reserve_open`), TST-22 (TV-4, TV-5/X3), TST-17 (`pool_split`, 2 000 случаев), TST-51 (`fixed`, 3 000 случаев), TST-53 (оракул `split_equal`, 5 000 случаев), плюс тесты без метки — граничные случаи и ошибки схемы. Остальные 12 тестов файла — `reserve_series`/`free_series` и G-001 (TST-02, TST-06, TST-08, TST-24, TST-33 (часть), TST-39 (часть); см. [ALG-11](alg-11-safe-to-spend.md)).
- `prototype/tests/g001.test.mjs` — TST-02 (G-001: `reserve_open = 150000`, взнос `RES-INS` 11-01, `free`); `prototype/tests/analyze.test.mjs` — идемпотентность взносов в `analyze`, предупреждения `W_RESERVE_*`.
- `prototype/tests/adversarial/semantics.test.mjs` (разделы sinking и резервов; в названиях метки TST-23/TST-29 не совпадают со [стратегией тестирования](../product/11-testing-strategy.md): по смыслу это TST-20…TST-22 и TST-02) и `prototype/tests/adversarial/golden_properties.test.mjs` (B-49, B-70).
- `prototype/tests/hardening.test.mjs` (40, один пропущен): закрытие пунктов этой страницы — `contribution_dates` и сдвиг в окно (Q-18, названия «TST-23 Q-18 …»), `reserve_open_ex` (Q-20), `target_missing` (Q-29), числа в `W_RESERVE_BEHIND` (Q-09, «REQ-069 Q-09 …»).
- `prototype/tests/sinking_report.test.mjs` (12), `transfer_guard.test.mjs` (8), `forms.test.mjs` (42, форма «Накопления» среди прочих): план взносов, «цель достигнута», «до срока нет дат взноса» (TST-20…22), подтверждение пачкой, вопрос о двойном вычитании (FP-08, FP-04).
- `prototype/tests/reserve_screen.test.mjs` (36), `reserve_backing_free.test.mjs` (9): «Освободить остаток», предупреждения `RESIDUAL` и `OVERDUE` с суммой, «Как посчитано» (FP-15); привязка резерва к счёту — характеризующие тесты расхождений (FP-47).
- `prototype/tests/properties.test.mjs` (13): FP-24, инварианты TST-39 (без резервов `free = trough`) и TST-31 на 1000 журналах общего генератора, в которых есть накопления и налоговый конверт; в каталоге мутаций ядра у `sinking.mjs` 9 порч, все убиты тестами модуля (S04 — `hardening`); замок вывода движка заметил 6, golden — 3, property-тесты — 1 (`../_ops/mutation.json`, раздел `engine`).

**Расхождения «псевдокод ≠ код»** (после сверки; п. 1 исправлен в псевдокоде страницы, остальное — в коде):

1. Исправлено на странице: `reserve_open` не ниже 0 (D-08: ручная или `release`-аллокация больше накопленного обнуляет резерв, а не роняет расчёт); `periods_to_goal(rem ≤ 0, …) = 0`; `contribution_plan` отвергает `mode ≠ refill_to_target` (`E_SCHEMA`); `contribution_allocations` проверяет `mode` и `fixed_minor` (`E_SCHEMA`).
2. Нецелый вход даёт `E_NOT_INTEGER` (от `assert_minor`), а не `E_SCHEMA`. Исключение, **закрытое Q-29**: `target_minor` не задан при `refill_to_target` — `E_SCHEMA` с причиной `target_missing` (у `contribution_plan` и `contribution_allocations`); у `fixed` без цели поведение прежнее.
3. `contribution_dates`: число месяцев ограничено константой `MAX_MONTHS = 12000` (в псевдокоде цикл `for j in 0..` без верхней границы — защита от неограниченного срока).
4. Предупреждения `W_RESERVE_BEHIND`, `W_RESERVE_RESIDUAL`, `W_RESERVE_OVERDUE` строит `analyze` (`index.mjs`, `reserve_warnings`), не `sinking.mjs`. **Закрыто (Q-09, C-030):** `W_RESERVE_BEHIND` несёт `{code, reserve_id, missed_count, missed_minor}` — число неподтверждённых взносов и их сумма; интерфейс показывает «Взносов не подтверждено: N на сумму X» (`warn.W_RESERVE_BEHIND_n`). `W_RESERVE_RESIDUAL` и `W_RESERVE_OVERDUE` в движке по-прежнему несут только `{code, reserve_id}`; сумму остатка добавляет слой показа (`reserve_open`, FP-15).
5. **Закрыто (FP-02, Q-18, К-11), было `todo`:** цикл `contribution_dates` теперь начинается с месяца `start − 1`, поэтому номинальная дата предыдущего месяца, которую `weekend = next` сдвигает в окно (`start = 2026-11-01`, `day = 31`: 2026-10-31 — суббота → 2026-11-02), попадает в расписание; запас в 62 дня за сроком учитывает сдвиг назад (`weekend = prev`). Тест — `hardening` («TST-23 Q-18 …»).

## Связанные страницы

- [ALG-11 safe-to-spend](alg-11-safe-to-spend.md), [ALG-06 налоговый конверт](alg-06-tax-envelope.md), [ALG-04 «могу ли я купить»](alg-04-can-i-afford.md), [ALG-01 даты и повторения](alg-01-recurrence-expansion.md)
- [Sinking funds (понятие)](../concepts/sinking-funds.md), [ADR-016 резервы](../decisions/adr-016-reserves-and-safe-to-spend.md), [ADR-002 деньги](../decisions/adr-002-money-minor-units.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [YNAB](../tools/ynab.md), [Actual Budget](../tools/actual-budget.md)
