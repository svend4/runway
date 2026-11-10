---
title: "ALG-04: «могу ли я это купить?»"
type: algorithm
status: reviewed
summary: "Q3: вердикт OK/TIGHT/FRAGILE/NO с узкой точкой после покупки, максимальная сумма на дату и самая ранняя дата без захода под буфер; суффиксный минимум ряда free за O(N), полный псевдокод и числа G-001."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/proposal-product.md, wiki/ideas/red-team-critique.md, wiki/decisions/adr-006-forecast-semantics.md, wiki/decisions/adr-016-reserves-and-safe-to-spend.md, wiki/tools/budget-guru.md, wiki/tools/pocketsmith.md]
updated: 2026-10-27
---

# ALG-04 «Могу ли я это купить?»

## Назначение

Решает вопрос **Q3**: как повлияет гипотетическая покупка (одна сумма на дату или график платежей) на свободные деньги. Три ответа по одной формуле: **(а)** вердикт и узкая точка после покупки в режимах `plan` и `worse`; **(б)** максимальная разовая сумма на дату, в том числе «прямо сейчас»; **(в)** самая ранняя дата, начиная с которой сумма S оставляет минимум свободных денег не ниже буфера. Это ликвидность по правилам пользователя, не совет покупать.

Реализует REQ-040…REQ-048, REQ-105 ([требования](../product/02-requirements.md)); идеи IDEA-11, IDEA-12, IDEA-14, IDEA-37 ([предложение по движку](../ideas/proposal-engine.md)); IDEA-58 (режим «в магазине») — v1.1, оболочка над `max_amount`. Решения — [ADR-006](../decisions/adr-006-forecast-semantics.md), [ADR-016](../decisions/adr-016-reserves-and-safe-to-spend.md); определение D-11, словарь C2 и решения §12 из `_ops/design-brief.md`. Понятие — [могу ли я это купить](../concepts/can-i-afford-it.md).

## Определения

Все числа — G-001, **горизонт 57 дн.** (`as_of` 2026-10-04, `N = 58`), `B = 50000` (задан явно), Q3 доступен: готовность 4, возраст якоря 0, правил `disabled` нет (гейт пройден).

- `free_m[i]` — свободный остаток режима `m ∈ {plan, worse}` (`trough − reserve_trough`, D-08; строит [ALG-11](alg-11-safe-to-spend.md)). Покупка резервов не меняет, поэтому она уменьшает `trough` и `free` на одну величину.
- `cum[i] = Σ amount_k` по частям с `date_k ≤ as_of + i`; `free_after[i] = free[i] − cum[i]`.
- `m_after = min_i free_after[i]` и первая дата минимума `at`; `margin = m_after − B`; `delta = min_i free[i] − m_after`; `cash_gap = min_i (trough[i] − cum[i]) < 0`.
- Суффиксный минимум `M[i] = min_{j ≥ i} free[j]` (не убывает по `i`).
- **Защитный признак режима** (C-015): `baseline_below_buffer_m = min_i free_m[i] < B` (то есть `by_mode[m].m_after + by_mode[m].delta < B`). Если он истинен: `S_max_m(D) = 0`, `earliest_m = null`; вердикт `OK` невозможен при `m = worse`, а при `m = plan` вердикт не выше `TIGHT`. Если ложен — формулы D-11 без изменений: `S_max_m(D) = max(0, M_m[idx(D)] − B)`; `earliest_m(S, nb) = min{ d ≥ nb : M_m[idx(d)] − S ≥ B }`. Суффиксный минимум `M` не видит просадки `free` до даты `D`, поэтому без признака `S_max` мог бы быть положительным при `min free < B`. Флаг `baseline_below_buffer` в ответе — по `worse` (более строгому режиму), по режимам выводится из `by_mode`.
- Вердикт: `NO` — `m_after_plan < 0`; `TIGHT` — `< B`; `FRAGILE` — `plan` не ниже `B`, а `m_after_worse < B`; иначе `OK`. Подписи: «не хватает», «впритык», «хрупко», «выдерживает».
- **Гейт** (C-018) — один для Q3 и [«можно потратить»](alg-11-safe-to-spend.md): `insufficient_data`, если (1) `readiness < ready.q3`, (2) уровень свежести `block` (`stale` или `no_anchor`), (3) эффективный буфер **не задан** (аргумент вызова `B`, иначе `ctx.buffer_minor`, N6; причина `no_buffer`; явный `0` — задан), (4) есть правило в статусе `disabled` (`rule_disabled`, C-024). Q1 и волны не блокируются: при незаданном буфере они считают `B = 0` с `W_BUFFER_UNSET`.

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `ctx.as_of`, `ctx.horizon_end` | `EpochDay` | сетка `N = horizon_end − as_of + 1` |
| `ctx` | `Analysis` | единый контекст `analyze(ws, query)` (C-012): `as_of, horizon_end, decision_currency, params, buffer_minor, series{plan,worse}, events{plan,worse}, reserve{plan,worse}, readiness, anchor_status, rule_status{}, warnings[], …` |
| `ctx.series[m]` | `Series` | `from, opening_minor, reserve_opening_minor, close[], trough[], reserve_trough[], reserve_close[], free[]` |
| `ctx.events[m]` | `CashEvent[]` | эффективные события режима (для «опорных событий») |
| `ctx.params` | `Params` | `headline_mode`, `ready.q3`, `stale.block_days` |
| `ctx.readiness`, `ctx.anchor_status`, `ctx.rule_status` | `int`, `{level, reason?, …}`, карта `rule_id → fresh/stale/disabled` | D-23, D-22, D-17: входы гейта |
| `purchase` | `{parts: [{date: EpochDay, amount_minor: Minor}], currency}` | `amount_minor > 0`, валюта = валюте решения |
| `B` | `Minor` | буфер ≥ 0 (для Q3 и «можно потратить» должен быть задан, C-018) |
| `D`, `nb` | `EpochDay` | дата покупки; «не раньше» |
| `S` | `Minor` | сумма > 0 |

| Выход | Тип |
|---|---|
| `PurchaseAnswer` | объединение (C-017): `{kind:'ok', verdict, by_mode{plan,worse}: {m_after, at, margin, delta, cash_gap}, s_max{plan,worse} или null, earliest{plan,worse} или null, flags{worse_gap, cash_gap, baseline_below_buffer} (по worse), buffer_minor, culprit_event_ids[], beyond_horizon_minor, warnings[]}` |
| иначе | `{kind:'insufficient_data', reason, reasons[]}`, `reason ∈ readiness\|stale\|no_anchor\|no_buffer\|rule_disabled`; или `{kind:'outside_horizon', horizon_end}` |

`beyond_horizon_minor` — сумма частей покупки позже `horizon_end`. Если она `> 0`, подпись вердикта обязана содержать «не все платежи учтены: X за горизонтом» (шаблон [ALG-12](alg-12-llm-tool-contract-and-number-verifier.md), не отдельная строка): вердикт `OK` по рассрочке с большей частью платежей за горизонтом — ложное спокойствие (RISK-02), поэтому оговорка неотделима от вердикта. Для покупки из нескольких частей `s_max` и `earliest` в v1 — `null`.

## Алгоритм

```pseudo
suffix_min(a: int[]) -> int[]:                      # M[i] = min(a[i..N−1]); O(N)
  M = int[N];  M[N−1] = a[N−1]
  for i in N−2 .. 0 (вниз):  M[i] = min(a[i], M[i+1])
  return M

# purchase_to_events — функция timeline.mjs (ALG-02, C-008): сценарию нужны календарь и счёт; цикл timeline ← afford запрещён.
# Ряды Q3 она не пересчитывает: check_purchase работает по готовому free, сценарий add_purchase — оракул (инвариант 1).

gate(ctx, B?) -> null | { kind: insufficient_data, reason, reasons[] }:    # один для Q3 и safe_to_spend (C-018); D-22, D-23, D-17; B — буфер вызова: эффективный = B ?? ctx.buffer_minor (N6)
  reasons = []
  если ctx.readiness < ctx.params.ready.q3:                 reasons += [readiness]
  если ctx.anchor_status.level = block:                     reasons += [ctx.anchor_status.reason]       # stale | no_anchor (C-010)
  если (B ?? ctx.buffer_minor) = null:                      reasons += [no_buffer]                      # явный 0 — «задан»
  если ∃ правило с ctx.rule_status[правило] = disabled:     reasons += [rule_disabled]                  # C-024
  return reasons пуст ? null : { kind: insufficient_data, reason: reasons[0], reasons }
  # level = banner (age > stale.banner_days) — плашка, не отказ; Q1 и волны гейтом не блокируются

normalize_parts(ctx, purchase) -> {parts, warnings}:
  если purchase.currency ≠ ctx.decision_currency: fail(E_CURRENCY_MISMATCH)
  если purchase.parts пуст: fail(E_SCHEMA)
  for p in purchase.parts:
    assert_minor(p.amount_minor);  если p.amount_minor ≤ 0: fail(E_SCHEMA)
    d = max(p.date, ctx.as_of)                      # прошлое → сегодня; warn W_DATE_CLAMPED (если p.date < as_of)
    если d > ctx.horizon_end: warn(W_PART_BEYOND_HORIZON); continue
    parts.push({ date: d, amount_minor: p.amount_minor })
  return { parts, warnings }

verdict_of(m_plan, m_worse, B):
  если m_plan  < 0: return NO
  если m_plan  < B: return TIGHT
  если m_worse < B: return FRAGILE
  return OK

binding_events(ctx, mode, a, j) -> Id[]:            # события, которыми «заканчивается» сужение после точки j
  rise = первый i > j с a[i] > a[j];  если нет: return []
  return [ e.cash_event_id для e ∈ ctx.events[mode] если e.amount_minor > 0 и j ≤ e.date − ctx.as_of ≤ rise − 1 ]

check_purchase(ctx, purchase, B) -> PurchaseAnswer:       # объединение ok | insufficient_data | outside_horizon (C-017)
  B = B ?? ctx.buffer_minor;  g = gate(ctx, B);  если g ≠ null: return g              # N6: буфер вызова перекрывает буфер ctx
  { parts, warnings } = normalize_parts(ctx, purchase)
  если parts пуст: return { kind: outside_horizon, horizon_end: ctx.horizon_end }
  beyond = Σ p.amount_minor по p ∈ purchase.parts, p.date > ctx.horizon_end             # части за горизонтом (W_PART_BEYOND_HORIZON)
  N = ctx.horizon_end − ctx.as_of + 1;  cum = нули(N)
  for p in parts: cum[p.date − ctx.as_of] += p.amount_minor
  for i in 1..N−1: cum[i] += cum[i−1]
  for m in [plan, worse]:
    s = ctx.series[m];  after[m] = [ s.free[i] − cum[i] для i ∈ 0..N−1 ]
    j[m] = первый argmin after[m];  cash_min = min_i (s.trough[i] − cum[i])    # строго «<»: ранняя дата (D-02)
    by_mode[m] = { m_after: after[m][j[m]], at: ctx.as_of + j[m], margin: after[m][j[m]] − B,
                   delta: min(s.free) − after[m][j[m]], cash_gap: cash_min < 0 }
  single = (len(purchase.parts) == 1);  h = ctx.params.headline_mode     # worse по умолчанию; несколько частей → s_max, earliest = null
  return { kind: ok,
    verdict: verdict_of(by_mode.plan.m_after, by_mode.worse.m_after, B),
    by_mode,
    s_max:    single ? { m: max_amount(ctx, parts[0].date, B, m) для m } : null,
    earliest: single ? { m: earliest_date(ctx, parts[0].amount_minor, ctx.as_of, B, m) для m } : null,
    flags: { worse_gap: by_mode.worse.m_after < 0, cash_gap: by_mode.worse.cash_gap,
             baseline_below_buffer: min(ctx.series.worse.free) < B },      # по worse; по режимам: by_mode[m].m_after + by_mode[m].delta < B
    buffer_minor: B,
    culprit_event_ids: binding_events(ctx, h, after[h], j[h]),
    beyond_horizon_minor: beyond,  warnings }                              # beyond > 0 → подпись «не все платежи учтены: X за горизонтом» (ALG-12)

max_amount(ctx, D, B, mode) -> Minor | null:        # (б)
  если D > ctx.horizon_end: return null             # «в горизонте нет»
  f = ctx.series[mode].free
  если min(f) < B: return 0                         # baseline_below_buffer_m (C-015): суффиксный минимум не видит просадки до D
  M = suffix_min(f)                                 # кэшируется в ctx: O(N) один раз
  return max(0, M[max(D, ctx.as_of) − ctx.as_of] − B)

earliest_date(ctx, S, not_before, B, mode) -> EpochDay | null:      # (в)
  если S ≤ 0: fail(E_SCHEMA);  need = assert_minor(S + B)
  если min(ctx.series[mode].free) < B: return null  # baseline_below_buffer_m (C-015)
  M = suffix_min(ctx.series[mode].free)
  N = len(M);  lo = max(not_before, ctx.as_of) − ctx.as_of;  hi = N
  while lo < hi:                                    # M не убывает: первая позиция с M[i] ≥ need
    mid = floor_div(lo + hi, 2)
    если M[mid] ≥ need: hi = mid  иначе: lo = mid + 1
  return lo < N ? ctx.as_of + lo : null
```

Пояснения. **Свободный остаток, а не `trough`**: покупка за счёт налогового конверта не получает `OK` ([ADR-016](../decisions/adr-016-reserves-and-safe-to-spend.md)). **Суффиксный минимум** даёт `S_max` за `O(1)`, а `earliest` — бинарным поиском, потому что покупка влияет только на дни `≥ D`; защитный признак `baseline_below_buffer_m` закрывает случай просадки `free` до даты покупки, которую суффикс не видит (C-015; проверено перебором 20 000 случайных рядов, числа G-001 не меняются: `min free` 93500 / 71000 ≥ `B`). **Гейт** — один для Q3 и «можно потратить», чтобы вердикт и число не расходились (C-018). **Главные числа** (б) и (в) для `headline_mode` (`worse`), значение `plan` показывается рядом. **Режимы**: `conservative` — старое имя `worse`; `expected` — v2. **Опорное событие** — приход, после которого `free` впервые поднимается выше точки минимума: в G-001 это задержанный доход `S-HOURLY` (11-05 → 11-19).

## Инварианты и свойства

1. **Оракул** (TST-53): ответ совпадает с полным пересчётом ряда со сценарием `add_purchase` ([ALG-02](alg-02-timeline-projection.md)).
2. **Монотонность** (TST-35): с ростом `S` вердикт не улучшается (`OK ≤ FRAGILE ≤ TIGHT ≤ NO`), `m_after` падает ровно на прирост; `S_max(D)` не убывает по `D`; `earliest` не раньше при большем `S`.
3. `S_max_worse ≤ S_max_plan` — безусловно (C-016): версия налогового правила выбирается по `base(e) = max(plan_date, as_of)`, не зависящей от режима, аллокации в `plan` и `worse` равны, а при `Σ rate_bp ≤ 10000` (валидация, C-032) `free_worse ≤ free_plan`; защитный признак `worse` не нарушает неравенство (при `baseline_worse` `S_max_worse = 0`).
4. `S_max(as_of) = STS(horizon_end)` (TST-39, [ALG-11](alg-11-safe-to-spend.md)).
5. `delta ≥ 0` и `delta ≤ Σ amount`; `cash_gap ⇒ worse_gap` (так как `free ≤ trough`); `m_after_plan ≥ 0 ⇒ NOT cash_gap` в `plan`.
6. **Границы по сумме — безусловно** (одна часть, C-015): `OK ⇔ S ≤ S_max_worse(D)`; `FRAGILE ⇔ S_max_worse < S ≤ S_max_plan`; `TIGHT ⇔ S_max_plan < S ≤ M_plan[idx(D)]` и `min_{i<idx(D)} free_plan[i] ≥ 0`; `NO` — иначе. Защитный признак даёт `S_max_m = 0` при `min free_m < B`, поэтому при `baseline_worse` вердикт `OK` невозможен ни при какой `S > 0`, а при `baseline_plan` вердикт не выше `TIGHT`.
7. При `B = 0` вердикт `TIGHT` недостижим. Результат детерминирован и не зависит от порядка частей.

## Сложность

`check_purchase`: `O(N + P + E)` на режим; `suffix_min` — `O(N)` один раз на ряд; `max_amount` — `O(1)`; `earliest_date` — `O(log N)`. Память `O(N)`. Для `N ≤ 181` полный пересчёт при каждом вводе укладывается в бюджет REQ-150; оптимизации не нужны (C23).

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| `S ≤ 0`, нецелая сумма | `fail(E_SCHEMA)` / `E_NOT_INTEGER` | покупка — положительное целое |
| Дата в прошлом | считается на `as_of`, предупреждение | расчёт не меняет прошлое |
| Дата или все части за `horizon_end` | `outside_horizon`; `s_max = null` | «в горизонте нет» (D-01) |
| Часть платежей за горизонтом | учтены только части в горизонте (`W_PART_BEYOND_HORIZON`), `beyond_horizon_minor > 0`; подпись вердикта содержит «не все платежи учтены: X за горизонтом» | REQ-044, C-017, RISK-02 |
| `S` ровно `S_max_worse` / на 1 minor больше | `OK`, `margin_worse = 0` / `FRAGILE` | порог включительный (`≥ B`) |
| `m_after_plan = B − 1` / `0` / `−1` | `TIGHT` / `TIGHT` / `NO` | границы `< B` и `< 0` |
| `min free_m < B` ещё до покупки (`baseline_below_buffer_m`) | `S_max_m = 0`, `earliest_m = null`; при `m = worse` вердикт не `OK`, при `m = plan` не выше `TIGHT`; флаг в ответе — по `worse`, по режимам из `by_mode` | суффикс `M` просадки до `D` не видит (C-015); синтетика — TV-6 |
| Резервы больше денег (`free < 0`) | любая `S > 0` — `NO`, `S_max = 0`, `earliest = null` | G-001-low |
| `S` больше максимума горизонта | `earliest = null` («в горизонте нет») | `M[N−1] − S < B` |
| Покупка и приход в один день | покупка уменьшает `trough` дня до прихода | «расходы раньше доходов» |
| Несколько частей | `s_max`, `earliest` = `null` в v1 | сдвиг графика платежей — v1.1 |
| `buffer_minor` не задан (`null`) | `insufficient_data`, причина `no_buffer`; явный `0` — задан | C-018: без буфера класс `TIGHT` пуст, вердикт вводит в заблуждение. Q1 и волны считают `B = 0` с `W_BUFFER_UNSET` |
| Готовность `< 4`, уровень свежести `block` (`stale` — якорь старше 21 дня, или `no_anchor`), правило `disabled` | `insufficient_data`, `reasons[]` перечисляет все причины; числа не показываются | D-22, D-23, C-018, C-024 |
| `parts` и `date`/`amount_minor` инструмента рассогласованы | `E_SCHEMA` на уровне инструмента | C-076: `date` = самая ранняя дата частей, `amount_minor` = сумма частей ([ALG-12](alg-12-llm-tool-contract-and-number-verifier.md)) |
| Валюта покупки ≠ валюте решения | `fail(E_CURRENCY_MISMATCH)` | перевод — [ALG-08](alg-08-fx-conversion.md) до вызова |

## Тест-векторы

**TV-1. G-001: дорожка 30000 на 2026-10-12.** `free_plan` (до покупки): 10-04 250000, 10-09 247500, 10-10 237500, 10-17 227500, 10-23 227500, 10-24 217500, 10-26 115500, 10-31 105500, 11-01 **93500**. После вычета 30000 (с 10-12): …, 10-26 85500, 10-31 75500, 11-01 **63500** → `m_after_plan = 63500`, `margin = +13500`, `delta = 30000`. `worse`: минимум до покупки 71000 (11-14) → `41000`, `margin = 41000 − 50000 = −9000`. Физический минимум после покупки: 175500 (10-31, `plan`), 153000 (11-14, `worse`): `cash_gap` нет. Вердикт: `m_plan = 63500 ≥ 50000`, `m_worse = 41000 < 50000` → **`FRAGILE`**; `worse_gap = false` (41000 ≥ 0); `baseline_below_buffer = false` (71000 ≥ 50000). Опорное событие: `j` = 11-14, `free` впервые выше 71000 с 11-20, событие 11-19 — задержанный `S-HOURLY`.

**TV-2. Границы по сумме на 10-12.** `M_plan = 93500`, `M_worse = 71000`: `S_max_worse = 21000`, `S_max_plan = 43500`.

| `S` | `m_after` plan | `m_after` worse | Вердикт |
|---:|---:|---:|---|
| 15000 | 78500 | 56000 | `OK` |
| 21000 | 72500 | 50000 | `OK` (`margin_worse = 0`) |
| 21001 | 72499 | 49999 | `FRAGILE` |
| 43500 | 50000 | 27500 | `FRAGILE` (`margin_plan = 0`) |
| 43501 | 49999 | 27499 | `TIGHT` |
| 93500 | 0 | −22500 | `TIGHT`, `worse_gap = true`, `cash_gap = false` (физический минимум `worse` 89500) |
| 93501 | −1 | −22501 | `NO` |
| 120000 | −26500 | −49000 | `NO` |

**TV-3. Максимум и ранняя дата.** `S_max(10-12)` и `S_max(10-04)`: plan `max(0, 93500 − 50000) = 43500`, worse `71000 − 50000 = 21000`. `earliest`, `worse`, `S = 30000`: `need = 80000`; `M_worse[11-19] = 71000 < 80000`, `M_worse[11-20] = 172200 ≥ 80000` (индекс 47; 11-19 даёт 71000, потому что «расходы раньше доходов») → **2026-11-20**; `plan`: `M_plan[10-04] = 93500 ≥ 80000` → 2026-10-04. `S = 60000`, `plan`: `need = 110000`, `M_plan[11-05] = 93500`, `M_plan[11-06] = 172200` → 2026-11-06; `worse` — 11-20. `S = 15000` — 10-04 в обоих режимах; с `nb = 11-10` — 11-10. `S = 122200` → 11-06 / 11-20; `S = 122201` (`need = 172201 > 172200`) → `null`.

**TV-4. G-001-low** (`opening = 220000`): `min free` plan −86500, worse −109000; `S = 1` → `m_after` −86501 / −109001 → `NO`; `min free < B` (`baseline_below_buffer`, C-015) → `S_max = 0`, `earliest = null` (то же давали прежние `M[0] − B < 0` и `free[N−1] = −7800 < B`); `baseline_below_buffer = true` (в обоих режимах), `cash_gap = false` (физический минимум 25499).

**TV-6. Защитный признак (синтетика, C-015).** Один ряд для обоих режимов: `free = [100, 40, 120, 120]`, `B = 50`, `D` = индекс 2. Суффиксный минимум `M = [40, 40, 120, 120]`. Прежняя формула: `S_max = M[2] − B = 120 − 50 = 70` (ложное «70 можно», хотя на втором дне `free = 40 < B` ещё до покупки). Новая: `min free = 40 < 50` → `baseline_below_buffer`, `S_max = 0`, `earliest = null`. Для `S = 10`: `free_after = [100, 40, 110, 110]`, `m_after = 40 < B` → вердикт не `OK` (`TIGHT`: `m_plan = 40 ≥ 0`, `< B`); в `worse` — `m_after = 40 < B`, `OK` невозможен. Для сравнения, при `free = [100, 90, 120, 120]` (`min free = 90 ≥ B`): `S_max = 70`, `S = 70` → `m_after = 50 = B` → `OK`, `S = 71` → `m_after = 49 < B` → `TIGHT` (ряд один для обоих режимов, поэтому проверка `plan` срабатывает раньше `FRAGILE`).

**TV-5. Покупка по частям** (30000 тремя платежами по 10000: 10-12, 11-16, 11-23): `cum` 10000 → 20000 → 30000. `plan`: минимум 83500 (11-01), `margin +33500`. `worse`: `free` 71000 на 11-14 при `cum = 10000` → 61000; на 11-16–11-19 при `cum = 20000` → **51000** (11-16), `margin +1000`, `delta = 20000`; с 11-20 `free` растёт. Вердикт `OK`, `s_max = earliest = null` (много частей).

## Варианты и альтернативы

Два класса «можно/нельзя» теряют `FRAGILE`; три класса «спокойно/впритык/нельзя» (из ранних предложений; у аналога на лендинге показан лишь пример «Да, спокойно») скрывают хрупкость и отменены (C2). Вероятностный Q3 (`p_fail`, допуск риска `α`) — v2 ([ALG-10](alg-10-uncertainty-monte-carlo.md)); по малым выборкам вероятность вводит в заблуждение. Бинарный поиск по `S` не нужен: границы получаются замкнутой формой (инвариант 6).

| Продукт | Что есть | Что не найдено |
|---|---|---|
| Budget Guru | заявлено: дата и сумма → вердикт и узкая точка; пример €300 → «Да, спокойно», минимум €7 600, а на скриншоте та же цифра у покупки 120 EUR; пороги не раскрыты, приложение не открывалось ([разбор](../tools/budget-guru.md)) | не проверено (не подтверждено) |
| [PocketSmith](../tools/pocketsmith.md) | what-if вручную: вторичный сценарий и бюджет покупки | автоматический «минимум после покупки» (не подтверждено) |
| [Actual Budget](../tools/actual-budget.md) | Balance Forecast (экспериментальный) | what-if и выделение низшей точки |
| [Firefly III](../tools/firefly-iii.md) | — | what-if; обход вручную (вывод) |
| [hledger](../tools/plain-text-accounting.md) | будущая транзакция или scenario-файл вручную | команда «самая узкая точка» (вывод) |
| [Float](../tools/business-cashflow-tools.md) | сценарии поверх базы, низшая точка окна | вердикт «да/нет» (вывод) |

### Не в v1

Режим `expected` и вероятностный Q3 (v2); режим «в магазине» — один экран над `max_amount` (v1.1); рассрочка с процентами и сдвиг графика платежей для `earliest` (v1.1); ранжирование «ходов» при нехватке вырезано (C10, заменено IDEA-93 в v2).

## Реализация в прототипе

Статус — **реализовано**: модуль `prototype/engine/afford.mjs` (чистые функции, ряды приходят готовыми в `ctx`; импортирует `money`, `dates` и из `timeline` — `get_param`, `normalize_mode`, `argmin_first`). Сверка с кодом и прогон тест-векторов TV-1…TV-6 и границ — 2026-10-04: числа сходятся (`FRAGILE`, 63500 / 41000, `margin` +13500 / −9000; таблица TV-2 по `S`; `S_max` 43500 / 21000; `earliest` 10-04 / 11-20, 11-06 / 11-20, `null` при 122201; G-001-low; синтетика TV-6; рассрочка TV-5). Реальные сигнатуры (`ctx` — `Analysis` из `analyze()`, C-012):

```js
suffix_min(a) -> int[]
gate(ctx, buffer_minor?) -> null | { kind: 'insufficient_data', reason, reasons }   // C-018, N6; общий с safe_to_spend
normalize_parts(ctx, purchase) -> { parts, warnings: [{code, part}] }
verdict_of(m_plan, m_worse, B) -> 'OK' | 'TIGHT' | 'FRAGILE' | 'NO'
binding_events(ctx, mode, a, j) -> Id[]
max_amount(ctx, D, B, mode?) -> Minor | null             // 0 при baseline_below_buffer (C-015)
earliest_date(ctx, S, not_before, B, mode?) -> EpochDay | null
check_purchase(ctx, purchase, B?) -> PurchaseAnswer      // объединение ok | insufficient_data | outside_horizon (C-017)
```

В том же модуле — `default_sts_horizon`, `safe_to_spend`, `sts_breakdown` ([ALG-11](alg-11-safe-to-spend.md)). `purchase_to_events(purchase, account_id, scenario_id?)` перенесена в `timeline.mjs` ([ALG-02](alg-02-timeline-projection.md), C-008).

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1: `afford.mjs` совпадает со снимком от 2026-10-05 построчно (после сверки в модуле ничего не менялось), числа G-001 прежние. Из «Не в v1» к 2026-10-27 уже есть v1.1: **рассрочка с процентами** (`engine/installment.mjs`, FP-08, REQ-044, REQ-192: `installment_plan` — равные части, аннуитет или дифференцированный график; `parts_from_debt_plan`, `purchase_from_parts`, `move_part_date`, `split_horizon`) и **сдвиг графика для `earliest`** (`engine/installment_earliest.mjs`, FP-28, A04.5: `shift_schedule`, `earliest_installment_start` — первая дата графика, при которой минимум свободных после покупки не ниже буфера, по режимам; проверяются только части внутри горизонта, для одной части результат равен `earliest_date`). Обе надстройки из `index.mjs` не реэкспортируются. Демо: экран «Купить» (вердикт, максимум на дату, самая ранняя дата, «Почему» с номером расчёта `c_…`), блок «Разбить на N платежей» с «держится с даты» (`buy_split.mjs`, FP-28), экран «В магазине» над `max_amount` (`store_mode.mjs`, FP-09, v1.1), «Лестница сумм» (`ladder.mjs`), расчёт «Купить» в Web Worker с откатом на главный поток (FP-21); по явному согласию — оценка «при уверенности α максимум X» (`prob_buy.mjs`, FP-11): детерминированный ответ она не меняет. **Не реализовано:** вероятностный Q3 как часть ответа по умолчанию (v2, по согласию он есть только как отдельный эксперимент), ранжирование «ходов» при нехватке (вырезано, C10), режим `expected` в расчёте. График рассрочки в демо — модель, а не договор банка (так сказано рядом с графиком).

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; номера TST — по [стратегии тестирования](../product/11-testing-strategy.md); в скобках число тестов файла):

| Файл | Что покрывает |
|---|---|
| `prototype/tests/afford.test.mjs` (36) | TST-04 (`verdict_of`, G-001: дорожка 30000 → `FRAGILE`, таблица и перебор по `S`, буфер вызова N6, гейт C-018, `binding_events`), TST-05 (`S_max`, `earliest` и перебор по определению), TST-08 (G-001-low и G-001-gap), TST-30 (`normalize_parts`, части, рассрочка, TV-5), TST-35 (`suffix_min`, TV-6 защитный признак, свойства на 10³ случаев, `free_worse ≤ free_plan`), TST-39 (`S_max(as_of) = STS(horizon_end)`, без резервов, G-001-late), TST-53 (оракул: `check_purchase` = полный пересчёт со сценарием `add_purchase`, 120 случаев) |
| `prototype/tests/g001.golden.test.mjs` (10) | ключи `G-001.*` §9.6 (Q3) и §9.7 через `analyze` и `afford` |
| `prototype/tests/adversarial/semantics.test.mjs`, `prototype/tests/adversarial/golden_properties.test.mjs` | состязательные: TV-6, `N = 1`, `B = 0` (`TIGHT` недостижим), границы `S_max_worse` ± 1 и `m_after` = `B`, `B − 1`, 0, −1, части и ошибки ввода, `not_before`, свойства `OK ⇔ S ≤ S_max_worse` (B-13, B-15, B-38), гейт (B-52) |
| `prototype/tests/properties.test.mjs` (13), `properties_mutation.test.mjs` (10) | FP-24: инварианты TST-35 (монотонность: `worse` не выше `plan`, больше сумма — не лучше вердикт, `OK ⇔ S ≤ S_max(worse)`) и TST-39 (`S_max(as_of) = STS(horizon_end)`, при `baseline_below_buffer` — `S_max = 0` и `earliest = null`) на 1000 журналах общего генератора; красный результат на подменах функций |
| `prototype/tests/installment.test.mjs` (7), `installment_earliest.test.mjs` (17) | рассрочка с процентами из `DebtPlan` для `check_purchase`; сдвиг графика для `earliest` (части раньше `as_of` зажимаются на `as_of`, части за горизонтом не «растворяют» проверку); в `installment_earliest` же — экран «Купить» с блоком «Разбить на N платежей» на заглушке DOM |
| `prototype/tests/showcase.test.mjs` (42), `prob_band.test.mjs` (20), `why_dialogs_full.test.mjs` (14), `calc_async*.test.mjs` | «В магазине» и «Лестница сумм», «при уверенности α максимум X» (по согласию), «Почему» вердикта с номером расчёта, расчёт «Купить» в Worker (FP-09, FP-11, FP-47, FP-21) |

**Расхождения «псевдокод ≠ код»** (смысл совпадает; код прототипа не менялся; багов кода не найдено):

1. Гейт и буфер вызова (N6). В коде `gate(ctx, buffer_minor?)` и `check_purchase(ctx, purchase, B?)`: эффективный буфер — `B ?? ctx.buffer_minor`. Раньше на странице гейт смотрел только `ctx.buffer_minor` — псевдокод исправлен (канон: design-brief N6).
2. `max_amount` и `earliest_date`: `mode` необязателен (по умолчанию `headline_mode`; `conservative` = `worse`); `B = null` или `B < 0` — `E_SCHEMA` (гейт выполняет вызывающий: `check_purchase`, инструменты); даты — `IsoDate` или `EpochDay`; `D` и `not_before` раньше `as_of` считаются на `as_of`.
3. `normalize_parts`: элементы `warnings` — `{code, part}` (`part` — индекс части в `purchase.parts`); пустой или отсутствующий `parts` — `E_SCHEMA` (добавлено в псевдокод).
4. `check_purchase` дополнительно проверяет, что `free` и `trough` обоих режимов имеют длину `N` (иначе `E_SCHEMA`); ответ `outside_horizon` предупреждений не несёт.
5. `suffix_min` не кэшируется в `ctx`: `check_purchase` пересчитывает его при каждом вызове `max_amount` и `earliest_date` (по два на режим) — `O(N)` каждый, на результат не влияет.

## Связанные страницы

- [ADR-006 семантика прогноза](../decisions/adr-006-forecast-semantics.md), [ADR-016 резервы](../decisions/adr-016-reserves-and-safe-to-spend.md)
- [ALG-11 safe-to-spend](alg-11-safe-to-spend.md), [ALG-02 временная шкала](alg-02-timeline-projection.md), [ALG-03 волны](alg-03-payment-waves-detection.md)
- [Могу ли я это купить](../concepts/can-i-afford-it.md), [требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [Budget Guru](../tools/budget-guru.md)
