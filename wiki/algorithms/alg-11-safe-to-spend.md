---
title: "ALG-11: safe-to-spend и свободный остаток"
type: algorithm
status: reviewed
summary: "Ряд резервов (налоговый конверт, sinking funds), свободный остаток free = trough − резервы и единое число «можно потратить до даты T при буфере B»; псевдокод, разложение числа и тест-векторы на G-001."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/proposal-product.md, wiki/ideas/red-team-critique.md, wiki/decisions/adr-016-reserves-and-safe-to-spend.md, wiki/tools/pocketsmith.md, wiki/tools/ynab.md, wiki/tools/firefly-iii.md]
updated: 2026-10-27
---

# ALG-11 Safe-to-spend со свободным остатком

## Назначение

Отвечает на вопрос Q3 в форме «сколько можно потратить до даты T, не уйдя под буфер»: одно число вместо трёх определений из предложений проекта (C6). Для этого алгоритм строит ряд **свободного остатка** `free` — физические деньги минус деньги, закреплённые в резервах (налоговый конверт и sinking funds). Тот же ряд питает вердикты, максимум и раннюю дату в [ALG-04](alg-04-can-i-afford.md).

Реализует REQ-045, REQ-057 (разложение числа), REQ-060…REQ-062 и REQ-063 (предупреждение о двойном вычитании) — [требования](../product/02-requirements.md); идеи IDEA-15, IDEA-41, IDEA-58 ([предложение по движку](../ideas/proposal-engine.md)); решение — [ADR-016](../decisions/adr-016-reserves-and-safe-to-spend.md); определения D-07, D-08, D-12 из `_ops/design-brief.md`. Понятие — [safe-to-spend](../concepts/safe-to-spend.md). Налоговые числа — расчёт по правилам, введённым пользователем, не консультация; взносы sinking ([ALG-05](alg-05-sinking-funds.md)) и аллокации налогового конверта ([ALG-06](alg-06-tax-envelope.md)) приходят на вход готовыми.

## Определения

Числа — G-001, **горизонт 57 дн.** (`as_of` 2026-10-04, `N = 58`), `B = 50000`.

- **Резерв ≠ перевод** (D-07): виртуальная отметка денег операционных счетов; `CashEvent` не создаёт, `close` и `trough` не меняет.
- За день `i` для резерва `r`: взнос или ручная правка `head` (в начале дня), **высвобождение** `released = min(funded, Σ|платежей, привязанных к r|)`, `true_up = платежи − released`, **аллокации от доходов дня** `tail` — после `trough`.
- `reserve_trough[i] = Σ_r funded_r` после `head` и высвобождения; `reserve_close[i]` — после `tail` (D-08).
- `free[i] = trough[i] − reserve_trough[i]`; может быть отрицательным (деньги есть, но закреплены).
- `STS_m(T) = max(0, min_{i ≤ idx(T)} free_m[i] − B)`; `short_to_buffer = max(0, B − min free)` — **«не хватает до буфера (с учётом резервов)»**, не путать с `gap_w` («дефицит волны (физический)», [ALG-03](alg-03-payment-waves-detection.md), X13) и с Q1 `need` («не хватает до буфера (деньги на счетах)», `B − min trough`; C-067). В каждом месте текста указывается, какой ряд использован.
- `sts_horizon = STS(horizon_end) = S_max(as_of)` (C-019): число «до конца горизонта». Если `sts_horizon < sts`, экран добавляет строку «до конца горизонта (дата) — X» (C-058; пример — TV-7).
- **Гейт** (C-018) — тот же, что у Q3 ([ALG-04](alg-04-can-i-afford.md)): `insufficient_data`, если `readiness < ready.q3`, уровень свежести `block` (`stale`/`no_anchor`), `buffer_minor` не задан (`no_buffer`) или есть правило `disabled` (`rule_disabled`). Расчёт `free` при `disabled` **продолжается** (резерв остаётся, иначе вердикт оптимистичнее), а числа, зависящие от правила, интерфейс заменяет текстом «правило не подтверждено с <даты>: подтвердите или измените» (C-024).
- `T` по умолчанию — дата прихода ближайшего ожидаемого поступления в `headline_mode` (в G-001 `worse` — **2026-11-19**: 11-05 + 14 дней); нет такого — `min(as_of + 30, horizon_end)`.

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `reserves` | `Reserve[]` | `reserve_id`, `funded_open_minor` (состояние на **начало** `as_of` после `reserve_open` = `funded_start + Σ записанных аллокаций с funded_as_of < date ≤ as_of`, в том числе по `posted`-доходу на `as_of`; C-020), `currency`, `backed_by_account_id` (v1: `null`) |
| `events` | `CashEvent[]` | эффективные события режима; платёж привязан к резерву через `reserve_id` |
| `allocations` | `Allocation[]` | будущие: `{reserve_id, date ≥ as_of, amount_minor, source: income\|schedule\|manual\|release}` из [ALG-05](alg-05-sinking-funds.md), [ALG-06](alg-06-tax-envelope.md) — **без** тех, чей `allocation_id` уже записан в журнале (идемпотентность расписания и налога, C-020) |
| `trough` | `Minor[N]` | физический минимум дня ([ALG-02](alg-02-timeline-projection.md)) |
| `T`, `B` | `EpochDay`, `Minor` | дата и буфер (для «можно потратить» — только заданный, C-018) |
| `ctx` | `Analysis` | единый контекст `analyze(ws, query)` ([ALG-04](alg-04-can-i-afford.md), C-012): `series[m]` с `opening_minor`, `reserve_opening_minor` (= `Σ funded_open_minor`) и `reserve[m]` — результат `reserve_series` |

| Выход | Тип |
|---|---|
| `reserve_series` | `{reserve_trough: Minor[N], reserve_close: Minor[N], by_reserve}`; `by_reserve[r] = {trough[], close[], contributed[], released[], true_up[], allocated[]}` |
| `free_series` | `Minor[N]` |
| `safe_to_spend` | `{sts: Minor, short_to_buffer: Minor, at: EpochDay, min_free: Minor, sts_horizon: Minor}` либо `insufficient_data` (гейт, C-018, C-019) |
| `sts_breakdown` | `[{id, v}]`, `Σ v = min_free − B` |

## Алгоритм

```pseudo
reserve_series(reserves, events, allocations, as_of, horizon_end) -> { reserve_trough, reserve_close, by_reserve }:
  N = horizon_end − as_of + 1
  R = [ r ∈ reserves если r.backed_by_account_id == null ] по reserve_id    # привязанные к счёту: деньги уже вне operating
  funded = { r.reserve_id: r.funded_open_minor }                              # после reserve_open (ALG-05, C-020); reserve_opening_minor = Σ funded — заполняет analyze
  for r in R:
    если funded[r] < 0: fail(E_SCHEMA)                                       # валюта резерва = валюте решения проверена при reserve.set и в build_events (X4, C-098), здесь — не проверяется
  для a ∈ allocations: если a.date < as_of: fail(E_SCHEMA)                  # прошлое сворачивает журнал; уже записанные allocation_id отфильтрованы (C-020)
  for e in events, e.reserve_id ∈ R, e.amount_minor < 0:  pay[e.reserve_id][e.date − as_of] += −e.amount_minor
  for a in allocations, a.reserve_id ∈ R, a.date ≤ horizon_end:
    если a.source == income: tail[a.reserve_id][a.date − as_of] += a.amount_minor
    иначе:                   head[a.reserve_id][a.date − as_of] += a.amount_minor    # schedule, manual, release (±)

  for i in 0..N−1:
    for r in R:
      before = funded[r];  funded[r] = max(0, funded[r] + head[r][i])       # взнос / ручная правка
      by_reserve[r].contributed[i] = funded[r] − before
      by_reserve[r].released[i] = min(funded[r], pay[r][i]);  funded[r] −= by_reserve[r].released[i]
      by_reserve[r].true_up[i]  = pay[r][i] − by_reserve[r].released[i]     # уйдёт из свободных денег
      by_reserve[r].trough[i]   = funded[r]
    reserve_trough[i] = Σ_r funded[r]
    for r in R:
      funded[r] += tail[r][i];  by_reserve[r].allocated[i] = tail[r][i];  by_reserve[r].close[i] = funded[r]
    reserve_close[i] = Σ_r funded[r]
  return { reserve_trough, reserve_close, by_reserve }

free_series(trough, reserve_trough) -> int[]:
  если len(trough) ≠ len(reserve_trough): fail(E_SCHEMA)
  return [ trough[i] − reserve_trough[i] для i ∈ 0..N−1 ]                   # без резервов free = trough

default_sts_horizon(ctx, as_of) -> EpochDay:
  h = ctx.params.headline_mode
  D = [ e.date для e ∈ ctx.events[h] если e.layer == planned и e.kind == income и e.amount_minor > 0
        и e.status ∈ {expected, overdue} и e.date ≥ as_of ]                  # e.date — эффективная дата режима h
  return D пуст ? min(as_of + 30, ctx.horizon_end) : min(D)

safe_to_spend(ctx, T, B, mode) -> { sts, short_to_buffer, at, min_free, sts_horizon } | insufficient_data:
  B = B ?? ctx.buffer_minor;  g = gate(ctx, B);  если g ≠ null: return g    # единый гейт Q3 и «можно потратить» из ALG-04 (C-018, N6): готовность, свежесть, буфер задан, нет disabled
  если T < ctx.as_of: fail(E_BAD_DATE)
  T2 = min(T, ctx.horizon_end);  если T2 ≠ T: warn(W_T_CLAMPED)
  f = ctx.series[mode].free;  j = T2 − ctx.as_of
  k = первый argmin f[0..j];  m = f[k]                                       # строго «<»: ранняя дата
  sts_horizon = max(0, min(f) − B)                                           # STS(horizon_end) = S_max(as_of) (C-019)
  return { sts: max(0, m − B), short_to_buffer: max(0, B − m), at: ctx.as_of + k, min_free: m, sts_horizon }

sts_breakdown(ctx, T, B, mode) -> rows:                                      # REQ-057; Σ rows = min_free − B
  B = B ?? ctx.buffer_minor;  s = ctx.series[mode];  rs = ctx.reserve[mode]  # rs — результат reserve_series режима
  r = ядро safe_to_spend без гейта(ctx, T, B, mode);  k = r.at − ctx.as_of   # гейт здесь не применяется: его проходит вызывающий до показа числа
  prev(i) = i == 0 ? s.opening_minor : s.close[i−1]
  out_i = s.trough[i] − prev(i);   in_i = s.close[i] − s.trough[i]
  return [ { id: opening,         v: s.opening_minor },
           { id: reserves_start,  v: −s.reserve_opening_minor },
           { id: payments,        v: Σ_{i ≤ k} out_i },                      # платежи до узкой точки включительно (≤ 0)
           { id: incomes,         v: Σ_{i < k} in_i },                       # приходы до неё (расходы раньше доходов)
           { id: released,        v: Σ_{i ≤ k} Σ_r rs.by_reserve[r].released[i] },     # возвращено из резервов
           { id: reserve_adds,    v: −(Σ_{i ≤ k} Σ_r rs.by_reserve[r].contributed[i]
                                       + Σ_{i < k} Σ_r rs.by_reserve[r].allocated[i]) },    # взносы и аллокации
           { id: buffer,          v: −B } ]
```

Решения. **Аллокация от дохода дня только в `reserve_close`**: иначе `trough` и резерв берутся в разном порядке, и в день прихода возникает искусственный минус. **Платёж, привязанный к резерву, не вычитается дважды**: `trough` падает на платёж, резерв — на высвобождение, `free` не меняется (до суммы накопленного). **Одно число**: минимум `free` на `[as_of, T]` минус буфер; не «остаток сегодня». Экран обязан показывать `T`, `B` и состав из `sts_breakdown`; «можно потратить X» без даты и буфера не выводится. Для налога высвобождение берёт сумму платежа, который ввёл пользователь. Резерв после платежа в срок **остаётся** до ручной отрицательной аллокации (`source = manual`, «освободить остаток»): интерфейс показывает `W_RESERVE_RESIDUAL`, резерв с прошедшим `due_date` без привязанного платежа — `W_RESERVE_OVERDUE`, автоосвобождения нет (C-059). Плановые взносы sinking в журнал автоматически не пишутся: до подтверждения прошедших взносов показывается `W_RESERVE_BEHIND`, в `funded_open` попадает только записанное (C-030). Если в рабочей области есть доход, но нет ни одного `TaxRule` и `Reserve`, показывается плашка `W_NO_RESERVES`: число посчитано по физическим деньгам (`free = trough`), в калькуляторе v0 ответ подписывается «без учёта резервов» (C-065). Если `sts_horizon < sts`, экран добавляет строку «до конца горизонта (дата) — X» (C-058).

## Инварианты и свойства

1. `free = trough − reserve_trough`; без резервов `free = trough` (TST-39).
2. Резерв не меняет `close` и `trough` (REQ-060): ряды с резервом и без него равны.
3. `funded ≥ 0` и `reserve_trough ≥ 0`; `reserve_close[i] − reserve_trough[i] = Σ allocated[i]` (доход дня).
4. Баланс резерва: `funded_end = funded_open + Σ contributed + Σ allocated − Σ released`; для платежей `released + true_up = |платёж|`.
5. Платёж, привязанный к резерву с `funded ≥ |платёж|`, не меняет `free` в день платежа.
6. `STS(T)` не возрастает с ростом `T`; `STS(horizon_end) = S_max(as_of)` (TST-39).
7. `sts_breakdown`: `Σ v = min_free − B`.
8. `STS_worse ≤ STS_plan` — безусловно (C-016): версия налогового правила выбирается по `base(e) = max(plan_date, as_of)`, не зависящей от режима, аллокации в `plan` и `worse` равны, при `Σ rate_bp ≤ 10000` (валидация, C-032) `free_worse ≤ free_plan`.
9. Детерминизм: результат не зависит от порядка `reserves`, `events`, `allocations`.

## Сложность

`reserve_series`: `O(N·R + E + A)` по времени и `O(N·R)` по памяти (`R` — число резервов, `E` событий, `A` аллокаций); `free_series` и `safe_to_spend` — `O(N)`; `sts_breakdown` — `O(N·R)`. Пересчёт целиком на каждое изменение допустим при `N ≤ 181` (REQ-151).

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| `min free − B < 0` | `sts = 0`, `short_to_buffer = B − min free`; экран пишет «не хватает до буфера», а не «0» | D-12 |
| `min free − B = 0` | `sts = 0`, `short_to_buffer = 0` | ровно на буфере |
| `T > horizon_end` / `T < as_of` | `T = horizon_end` с предупреждением / `fail(E_BAD_DATE)` | за горизонтом ряда нет |
| `T = as_of` | окно из одного дня: `free[0] − B` | включительная граница |
| Просроченный доход (`overdue`) | его `e.date = as_of` (в `worse` + задержка) задаёт `T` | D-04 |
| Ожидаемых доходов нет | `T = min(as_of + 30, horizon_end)` | D-12 |
| Резервов нет | `free = trough` | инвариант 1 |
| Резервы больше денег (`free < 0`) | `sts = 0`, показывается `short_to_buffer`; деньги есть, но закреплены | G-001-low |
| Платёж больше накопленного | `released = funded`, остаток `true_up` ложится на свободные деньги | D-17, ADR-016 |
| Платёж привязан, резерв пуст | `released = 0`, `true_up` = весь платёж | `min(0, …) = 0` |
| Резерв с `backed_by_account_id ≠ null` | в `R` не входит, предупреждение | деньги вне operating, иначе двойной счёт |
| Валюта резерва ≠ валюте решения | `E_CURRENCY_MISMATCH` при записи `reserve.set` и в `build_events`; внутри `reserve_series` проверки нет | в v1 резерв хранится в валюте решения (X4); функция не ссылается на свободную переменную (C-098) |
| Реальный перевод на накопительный счёт при резерве | интерфейс предупреждает о двойном вычитании | X12, REQ-063: перевод 100000 при резерве 150000 снижает `free` с 250000 до 150000 |
| Смена ставки налога между датами `plan` и `worse` | версия правила выбирается по `base(e) = max(plan_date, as_of)` — одна для обоих режимов; аллокации равны, инвариант 8 и `S_max_worse ≤ S_max_plan` сохраняются | C-016; прежняя оговорка «теряют силу» отменена |
| Ставки правил на одно поступление в сумме `> 10000`, пустой `applies_to` | `E_RULE_INVALID` / ошибка валидации | аллокация не может превышать доход (C-032) |
| Готовность < 4, уровень свежести `block` (`stale`, `no_anchor`), буфер не задан, правило `disabled` | `insufficient_data` с `reasons[]`; числа не показываются; расчёт `free` при `disabled` продолжается | гейт D-11 (C-018, C-024); D-22, D-23 |
| `min free < B` на горизонте, но не на `[as_of, T]` (G-001-late) | `sts` по `T` положителен, `sts_horizon = 0`, экран добавляет строку «до конца горизонта» | C-058 |

## Тест-векторы

**TV-1. Ряды резервов G-001.** `RES-TAX`: 150000, `RES-INS`: 0, `P-TAX1` (10-23, −50000) привязан к `RES-TAX`; взнос `RES-INS` +12000 на 11-01; правило `TR-20`: 2000 bp. День 10-04: `reserve_trough = 150000`, `free = 400000 − 150000 = 250000`. 10-23: `released = min(150000, 50000) = 50000`, `true_up = 0`, `reserve_trough = 100000`, `trough = 327500`, `free = 227500` — как до платежа (инвариант 5). 11-01: `head = +12000` → 112000; `free = 205500 − 112000 = 93500`. 11-05, `plan`: приход 279000 → `tail = mul_div(279000, 2000, 10000) = 55800`; `reserve_trough = 112000`, `reserve_close = 167800`; `free[11-05] = 205500 − 112000 = 93500` (минимум `plan`), с 11-06 `reserve_trough = 167800`. `worse`: то же с 11-19/11-20.

**TV-2. «Можно потратить», `B = 50000`.** `min free` на `[10-04, T]`:

| `T` | `plan` | `worse` | `STS` plan | `STS` worse |
|---|---|---|---:|---:|
| 2026-10-31 | 105500 | 105500 | 55500 | 55500 |
| **2026-11-19** (по умолчанию) | 93500<!--num:G-001.free.min.plan=93500--> (11-01) | 71000<!--num:G-001.free.min.worse=71000--> (11-14) | 43500<!--num:G-001.safe_to_spend.plan=43500--> | **21000**<!--num:G-001.safe_to_spend.worse=21000--> |
| 2026-11-30 | 93500 | 71000 | 43500 | 21000 |

Строка `T = 11-30` равна `S_max(as_of)` из TV-3 [ALG-04](alg-04-can-i-afford.md) (инвариант 6). Экран (подпись по C-084): «до 19 ноября свободно 210,00 € при буфере 500,00 € (если хуже); резервы на момент минимума (14 ноября) — 1 120,00 €, на сегодня — 1 500,00 €; по плану — 435,00 €» (`21000 = 183000 − 112000 − 50000`; прежняя подпись «при резервах 1 500,00 €» не сходилась: `1830 − 1500 − 500 = −170`). Показывается только после гейта (C-018). `default_sts_horizon`: доход `S-HOURLY` 11-05 + 14 = 11-19 (`worse`); при `headline_mode = plan` — 11-05; без дохода — `min(10-04 + 30, 11-30)` = 2026-11-03.

**TV-3. Разложение (REQ-057), `worse`, `T = 11-19`, `at = 11-14`.** Строки: `opening` 400000; `reserves_start` −150000; `payments` −217000 (связь 2×2500, продукты 6×10000, налог 50000, аренда 90000, ЖКХ 12000); `incomes` 0; `released` +50000; `reserve_adds` −12000; `buffer` −50000; сумма `21000` = `71000 − 50000`; резервы на момент минимума (11-14) `150000 − 50000 + 12000 = 112000`, на сегодня — 150000 (`reserved` по `RES-TAX`). Экран объединяет `payments + released = −167000` («платежи без налога 1 670,00 €», налог нейтрален). `plan`, `at = 11-01`: `payments` −194500, `released` +50000, `reserve_adds` −12000 → `400000 − 150000 − 194500 + 50000 − 12000 − 50000 = 43500`.

**TV-4. G-001-low** (`opening = 220000`, `T = 11-19`): `min free` plan −86500 (11-01), worse −109000 (11-14) → `sts = 0`, `short_to_buffer = 50000 + 86500 = 136500` и `50000 + 109000 = 159000`; физические деньги при этом не отрицательны (минимум `trough` 25500 / 3000) — «деньги есть, но закреплены под налог и страховку».

**TV-5. Платёж больше резерва.** `RES-TAX` с `funded_open_minor = 30000`, платёж 50000 на 10-23: `released = 30000`, `true_up = 20000`; `reserve_trough` 30000 → 0; `free` 347500 (10-22) → 327500 (10-23), падение 20000 = `true_up`. Минимумы: plan 193500 (11-01), worse 171000 (11-14); `STS(11-19)` = 143500 / 121000.

**TV-6. Без резервов.** `free = trough`: `STS(11-19)` plan `205500 − 50000 = 155500`, worse `183000 − 50000 = 133000`. Разница с TV-2 (112000) — закреплённые деньги.

**TV-7. G-001-late (C-058).** G-001 + плановый расход `P-X` −250000 на 2026-11-26 (без `is_obligation`; иллюстрация, ключи `G-001-late.*`). Ряды до 11-25 не меняются: на `[10-04, 11-19]` `min free` = 93500 (plan) / 71000 (worse), поэтому `STS(11-19)` = **43500 / 21000**. На 11-26 `trough = 350000 − 250000 = 100000`, на 11-28 — `90000`; `reserve_trough = 167800` в обоих режимах (доход `worse` пришёл 11-19) → `min free` на всём горизонте = `90000 − 167800 =` **−77800** (11-28, оба режима). Поэтому `sts_horizon = STS(horizon_end) = S_max(as_of) = 0`, `safe_to_spend(T = horizon_end)`: `sts = 0`, `short_to_buffer = 50000 + 77800 =` **127800**; `baseline_below_buffer = true` → `S_max = 0`, `earliest = null`, вердикт `OK` невозможен. Экран: «до 19 ноября свободно 210,00 € (если хуже)» дополняется строкой «до конца горизонта — 0 (не хватает до буфера 1 278,00 €)». Golden-тест различает `STS(T)` и `STS(horizon_end)` (TST-39).

## Варианты и альтернативы

Остаток минус бюджеты, резерв только как отдельный счёт и «вычитать резервы за горизонтом» рассмотрены в [ADR-016](../decisions/adr-016-reserves-and-safe-to-spend.md): динамика высвобождения решает двойной счёт без условий `due > T`. Три определения «можно потратить» (C6) свелись к одному `STS(T)`.

| Продукт | Что есть | Что не найдено |
|---|---|---|
| Budget Guru | число «можно потратить» в источниках не описано (не подтверждено) ([разбор](../tools/budget-guru.md)) | не проверено |
| [PocketSmith](../tools/pocketsmith.md) | Safe Balance (бета с 2016-03-09): факт + неполученный доход − неистраченные расходные бюджеты категорий | привязка к датам и узкой точке |
| [YNAB](../tools/ynab.md) | «Available» в категории «сейчас»; Targets («Set aside another», «Refill up to», «Have a balance of») для редких трат | what-if на траектории |
| [Actual Budget](../tools/actual-budget.md) | конверты, автоматизации Save by Date и Refill to Cap (экспериментальные) | прогноз свободных денег к дате |
| [Firefly III](../tools/firefly-iii.md) | piggy banks — метка внутри счёта, баланс не меняется; автоматических взносов нет | расчёт «свободно к дате» |
| [hledger](../tools/plain-text-accounting.md) | виртуальные субсчета-конверты | «свободно» как функция времени (вывод) |

### Не в v1

Привязка резерва к реальному счёту (v1.1); квартальные авансы и именованные налоговые режимы как данные со схемой (v2); режим «в магазине» — один экран над `STS(as_of)` (v1.1, IDEA-58); ранжирование «ходов» при нехватке не делается (C10).

## Реализация в прототипе

Статус — **реализовано**: модули `prototype/engine/sinking.mjs` (резервы; импортирует `money`, `dates`) и `prototype/engine/afford.mjs` (число «можно потратить»; `money`, `dates`, `timeline`); оба реэкспортируются из `prototype/engine/index.mjs`, где `analyze` строит `reserve_series` → `free_series` по обоим режимам и кладёт результат в `Analysis` (C-012). Сверка с кодом и прогон тест-векторов TV-1…TV-7 — 2026-10-04: числа сходятся (`reserve_trough` 150000 → 100000 → 112000, `free` 250000 / 227500 / 93500; `released` 50000, `tail` 55800; STS на `T` = 10-31, 11-19, 11-30; разложение `sts_breakdown` для `worse` и `plan`; G-001-low; TV-5 с резервом 30000; без резервов 155500 / 133000; G-001-late: `sts_horizon = 0`, `short_to_buffer = 127800`). Реальные сигнатуры:

```js
// sinking.mjs
reserve_series(reserves, events, allocations, as_of, horizon_end) -> { reserve_trough, reserve_close, by_reserve }   // reserve.funded_open_minor (C-020, C-098)
free_series(trough, reserve_trough) -> int[]
// afford.mjs
default_sts_horizon(ctx, as_of?) -> EpochDay
safe_to_spend(ctx, T, B?, mode?) -> { sts, short_to_buffer, at, min_free, sts_horizon, warnings? } | insufficient_data   // C-018, C-019
sts_breakdown(ctx, T, B?, mode?) -> [{ id, v }]               // REQ-057, Σ v = min_free − B (C-019)
```

`reserve_open(reserve, recorded_allocations, as_of) -> Minor` — в `sinking.mjs` ([ALG-05](alg-05-sinking-funds.md), C-020); `gate(ctx, buffer_minor?)` — в `afford.mjs` ([ALG-04](alg-04-can-i-afford.md), C-018, N6).

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1: `afford.mjs` совпадает со снимком от 2026-10-05 построчно, у `sinking.mjs` аддитивные изменения описаны в [ALG-05](alg-05-sinking-funds.md) (`reserve_open_ex`, расписание взносов, числа в `W_RESERVE_BEHIND`); `reserve_series`, `free_series`, `safe_to_spend` и `sts_breakdown` не менялись, числа G-001 прежние. Из «Не в v1» уже есть режим **«в магазине»** — отдельный экран над `max_amount` (`store_mode.mjs`, FP-09). Демо вокруг числа «можно потратить»: на «Обзоре» число с полем даты и подписью, откуда оно (`ov.sts_*`), разложение «Как посчитано» по `sts_breakdown`, карточка «Куда делись деньги» (резервы + платежи до узкой точки за вычетом поступлений + буфер + свободно = остаток; сходимость проверяется по остатку из ряда движка и по числу из `safe_to_spend`, FP-28), фразы о нехватке с первой датой нарушения буфера и ближайшим ожидаемым поступлением (REQ-046, FP-28), карточка «Запас хода» (FP-03); экран «Резервы» — строка «остаток − резервы = свободно на сегодня», «Освободить остаток», «Как посчитано» (FP-15); при отключённом (`disabled`) правиле числа «свободно» заменены текстом «не подтверждено с <даты>» на «Резервах» и «Обзоре» (C-024, FP-15, FP-47). **Не реализовано:** привязка резерва к реальному счёту доведена не до конца (в движке `backed_by_account_id` есть; перевод меньше суммы резерва поднимает `free`, селектора в интерфейсе нет — решение по D-07 за владельцем, FP-35, REQ-191), квартальные авансы и именованные налоговые режимы как данные со схемой (v2), ранжирование «ходов» при нехватке (не делается, C10).

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; номера TST — по [стратегии тестирования](../product/11-testing-strategy.md); в скобках число тестов файла):

| Файл | Что покрывает |
|---|---|
| `prototype/tests/sinking.test.mjs` | TST-02 (G-001: `reserve_trough`, `reserve_close`, `free` по таблице §9.4 в `plan` и `worse`), TST-06 / TST-39 (STS по рядам `free`), TST-08 (G-001-low), G-001-gap, G-001-late, TV-5 (платёж больше резерва), `reserve_series` (пустой резерв, ручная правка, привязанный к счёту, ошибки), TST-33 (часть: порядок входов, баланс резерва — инварианты 3, 4) |
| `prototype/tests/afford.test.mjs` | TST-06 (`T` по умолчанию, STS на `T` = 10-31, 11-19, `horizon_end`, подпись C-084, `safe_to_spend`, `default_sts_horizon`, `sts_breakdown`, TV-5), TST-39 (`S_max(as_of) = STS(horizon_end)`, без резервов `free = trough`, G-001-late, свойство 10³ случаев), TST-08 (G-001-low, G-001-gap), TST-06 / TST-39 на случайных рабочих областях (`Σ sts_breakdown = min_free − B`) |
| `prototype/tests/timeline.test.mjs` | TST-53 (оракул B: `reserve_series` + `free_series` против наивной реализации D-08, 3000 случаев) |
| `prototype/tests/analyze.test.mjs` | резервы в `analyze`: `funded_open` (C-020), привязанный к счёту резерв, идемпотентность взносов `sinking`, `W_NO_RESERVES`, `W_RESERVE_*` |
| `prototype/tests/g001.golden.test.mjs` | ключи `G-001.*` §9.4 (резервы, `free`) и §9.7 (STS) |
| `prototype/tests/adversarial/semantics.test.mjs`, `prototype/tests/adversarial/golden_properties.test.mjs` | состязательные: порядок дня `head → release → trough → tail → close`, аллокация дохода дня не покрывает платёж этого дня, платёж привязанного резерва не меняет `free` (инв. 5), `disabled`-правило не отключает резерв (C-024), двойное вычитание при реальном переводе (X12, REQ-063), STS (`T` до `as_of`, зажим `T`, `STS(horizon_end) = S_max(as_of)`), `sts_breakdown` на G-001-low / -gap / -late; часть тестов этих файлов помечена номерами TST, которых нет в стратегии для этой темы (например, `reserve_series` — «TST-29») |
| `prototype/tests/properties.test.mjs` (13), `properties_mutation.test.mjs` (10), `engine_lock.test.mjs` (12) | FP-24: инвариант TST-39 (`S_max(as_of) = STS(horizon_end)`; без резервов `free = trough`) и TST-31 на 1000 журналах общего генератора с налоговым конвертом и накоплениями, красный результат на подменах; замок вывода `analyze` (ряды резервов и `free` входят в сумму) на 500 журналах |
| `prototype/tests/where_money.test.mjs` (16), `reserve_screen.test.mjs` (36), `overview_masked.test.mjs` (8), `reserve_backing_free.test.mjs` (9), `showcase.test.mjs` (42) | «Куда делись деньги» (включая подмену платежа и остатка), экран «Резервы» («Освободить остаток», «Как посчитано», отключённое правило), «Обзор» без ряда «свободно» при `disabled`, привязка резерва к счёту (характеризующие тесты), «В магазине» (FP-28, FP-15, FP-47, FP-09) |

**Расхождения «псевдокод ≠ код»** (смысл совпадает; при сверке 2026-10-04 код не менялся, багов кода не найдено; изменения `sinking.mjs` после сверки — в абзаце «Состояние на 2026-10-27» выше):

1. Гейт и буфер вызова (N6): `safe_to_spend(ctx, T, B?, mode?)` берёт эффективный буфер `B ?? ctx.buffer_minor` и передаёт его в `gate(ctx, B)`; то же у `sts_breakdown`. Псевдокод исправлен.
2. `sts_breakdown` не вызывает `safe_to_spend` и гейт не применяет (его проходит вызывающий перед показом числа); `T` зажимается границей горизонта так же, как в `safe_to_spend`; нет буфера ни в вызове, ни в `ctx` — `E_SCHEMA`. Псевдокод исправлен.
3. `safe_to_spend` добавляет `warnings: [{code: 'W_T_CLAMPED'}]` только когда `T` зажат (поля нет, когда предупреждения нет); `T` — `IsoDate` или `EpochDay`; `mode` по умолчанию `headline_mode`, `conservative` = `worse`. `default_sts_horizon(ctx, as_of?)`: `as_of` по умолчанию `ctx.as_of`.
4. `reserve_series`: резервы упорядочены по `reserve_id`; `funded_open_minor` не задан — 0; дополнительно `E_SCHEMA` для пустого, повторного или `__proto__` `reserve_id`, неизвестного `source` и отрицательной аллокации `source = income` (иначе `funded < 0`); аллокации чужого или привязанного к счёту резерва, после горизонта и события вне сетки молча игнорируются. `source = release` обрабатывается как `schedule` и `manual` (в начале дня, `head`): страница дополнена, как в каноне (design-brief §3.7).
5. `reserve_open` ([ALG-05](alg-05-sinking-funds.md)) возвращает не меньше 0 (излишек записанного списания отбрасывается, D-08), поэтому `E_SCHEMA` на отрицательном `funded_open_minor` в `reserve_series` при вызове через `analyze` недостижим.
6. Предупреждения `W_RESERVE_BEHIND`, `W_RESERVE_RESIDUAL`, `W_RESERVE_OVERDUE`, `W_NO_RESERVES` строит `analyze` (`prototype/engine/index.mjs`), а не `reserve_series`; здесь их нет. С волны 1 `W_RESERVE_BEHIND` несёт числа `missed_count` и `missed_minor` ([ALG-05](alg-05-sinking-funds.md), Q-09).

## Связанные страницы

- [ADR-016 резервы и safe-to-spend](../decisions/adr-016-reserves-and-safe-to-spend.md), [safe-to-spend (понятие)](../concepts/safe-to-spend.md)
- [ALG-04 «могу ли я купить»](alg-04-can-i-afford.md), [ALG-05 sinking funds](alg-05-sinking-funds.md), [ALG-06 налоговый конверт](alg-06-tax-envelope.md), [ALG-03 волны](alg-03-payment-waves-detection.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [PocketSmith](../tools/pocketsmith.md)
