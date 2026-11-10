---
title: "ALG-09: долги и рассрочки"
type: algorithm
status: reviewed
summary: "Дробление покупки на части без процентов (v1), график аннуитета и дифференцированный (v1.1), досрочное погашение и ре-якорение (v2); целочисленный псевдокод, последний платёж поглощает остаток."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/red-team-critique.md, wiki/decisions/adr-002-money-minor-units.md, wiki/tools/ynab.md, wiki/tools/firefly-iii.md, wiki/tools/plain-text-accounting.md, wiki/tools/budget-guru.md, wiki/tools/open-source-mobile-trackers.md]
updated: 2026-11-09
---

# ALG-09 Долги и рассрочки

## Назначение

Платёж по кредиту или рассрочке — обязательство, которое попадает в волны ([ALG-03](alg-03-payment-waves-detection.md)) и в минимум ряда (Q1, Q3). Алгоритм превращает «долг на сумму P, ставка r, n платежей» в **график** платежей, который сходится копейка в копейку, и в плановые события для [ALG-02](alg-02-timeline-projection.md). Покупка «в рассрочку» ([ALG-04](alg-04-can-i-afford.md)) — тот же график без процентов.

Реализует REQ-044 (v1: дробление), REQ-082 (v1.1: график), REQ-083 (v2: ре-якорение, досрочное) — [требования](../product/02-requirements.md); идеи IDEA-14, IDEA-22 ([предложение по движку](../ideas/proposal-engine.md)); арифметика — [ADR-002](../decisions/adr-002-money-minor-units.md). Понятие — [долги и рассрочки](../concepts/debt-and-installments.md). График по модели не равен договору банка (дни, комиссии, плавающая ставка); это расчёт по введённым данным, не консультация.

## Определения

- **`DebtPlan`** (§3.8, v1.1, C-039): `debt_id`, `account_id` (счёт долга, `liquidity = debt`, справочный), `pay_account_id` (operating-счёт платежей), `currency` (должна совпадать с валютой `pay_account_id`, иначе `E_CURRENCY_MISMATCH`; мультивалютный долг — вне среза), `kind ∈ {annuity, differential, installment_0}`, `principal_minor`, `rate_bp`, `n`, `start_date`, `cadence`, `schedule[]`. План описывает **оставшийся** долг: `principal_minor` — остаток, `start_date` — дата первого неоплаченного платежа. Переход «гипотетическая рассрочка из [ALG-04](alg-04-can-i-afford.md) → `DebtPlan`» до v1.1 — ручной ввод плановых платежей.
- **Период** — месяц; `rate_bp` — годовая номинальная ставка; ставка периода `i = rate_bp / 120000` (`120000 = 12·10^4`), без дней и без капитализации по календарю (сдвиг на фактические дни — в договоре, не в модели).
- **Аннуитет**: `A = P·i / (1 − (1+i)^−n)`. В целых: `u = 120000 + r`, `A = round_div(P·r·u^n, 120000·(u^n − 120000^n), rounding)` (BigInt).
- **Дифференцированный**: часть основного долга `split_equal(P, n)[k−1]`, проценты на остаток.
- **Рассрочка 0 %** (`installment_0`): платёж k — `split_equal(total, n)[k−1]`; первые части получают лишние minor.
- Строка графика: `{k, date, payment_minor, interest_minor, principal_minor, balance_minor}`; `payment = principal + interest`.

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `principal` | `Minor` | остаток долга (≥ 1) |
| `rate_bp` | `Bp` | 0…100000; для `installment_0` строго 0 |
| `n` | `int` | число платежей, 1…600 |
| `start` | `EpochDay` | дата первого платежа; остальные — `add_months(start, k−1)` (от `start`, без дрейфа) |
| `kind`, `cadence`, `rounding` | | в v1.1 `cadence = {freq: M, interval: 1}`, `rounding = half_even` |
| `debt` | `DebtPlan` | для `schedule_to_events`, `reanchor`, `prepay` (нужны `rate_bp`, `kind`, `pay_account_id`, `currency`; C-039, C-040) |

| Выход | Тип |
|---|---|
| `annuity_payment` | `Minor` |
| `amortization_schedule` | `Row[]` |
| `installment_parts` | `int[]`, Σ = `total` |
| `schedule_to_events` | `CashEvent[]` (план, `is_obligation = true`, счёт — `debt.pay_account_id`, валюта — `debt.currency`) |

## Алгоритм

```pseudo
validate_debt(P, rate_bp, n, kind):
  P, n, rate_bp — целые (иначе E_NOT_INTEGER);  kind ∈ {annuity, differential, installment_0};  P ≥ 1;  1 ≤ n ≤ 600;  0 ≤ rate_bp ≤ 100000       иначе fail(E_SCHEMA)
  kind == installment_0 ⇒ rate_bp == 0;   kind ∈ {annuity, differential} ⇒ P ≥ n     иначе fail(E_SCHEMA)

annuity_payment(principal, rate_bp, n, rounding = half_even):
  validate_debt(principal, rate_bp, n, annuity)
  rounding ∈ {half_even, half_up} иначе fail(E_SCHEMA)                # N9: floor и ceil для графика не допускаются
  если rate_bp == 0: return ceil_div(principal, n)                    # = наибольшая часть split_equal
  u = 120000 + rate_bp;  un = u^n;  dn = 120000^n                     # BigInt
  return round_div(principal · rate_bp · un, 120000 · (un − dn), rounding)      # не safe → E_OVERFLOW

installment_parts(total, n):  return split_equal(total, n)            # n ≥ 1, total ≥ 1; части могут быть 0 при total < n

amortization_schedule({principal, rate_bp, n, start, cadence, kind, rounding = half_even}):
  cadence ≠ {M, 1} → fail(E_SCHEMA)                                   # v1.1: только раз в месяц
  rounding ∈ {half_even, half_up} иначе fail(E_SCHEMA)                # N9
  если kind == annuity и rate_bp == 0: kind = installment_0           # 0 % — это рассрочка
  validate_debt(principal, rate_bp, n, kind)
  A = kind == annuity ? annuity_payment(principal, rate_bp, n, rounding) : null
  parts = kind ≠ annuity ? split_equal(principal, n) : null           # дифф.: части долга; рассрочка: части платежа
  bal = principal;  rows = []
  for k in 1..n:
    interest = kind == installment_0 ? 0 : mul_div(bal, rate_bp, 120000, rounding)
    если k == n:           p = bal                                    # последний платёж поглощает остаток округлений
    elif kind == annuity:  p = min(max(A − interest, 1), bal − (n − k))     # зажим: каждой оставшейся строке — хотя бы 1 minor (P ≥ n); где A − interest уже в границах, ничего не меняет
    else:                  p = parts[k−1]
    если p < 0 или p > bal: fail(E_SCHEMA, 'degenerate')              # страховка: при зажиме и P ≥ n не достигается
    bal −= p
    rows += [{k, date: add_months(start, k−1), payment_minor: p + interest, interest_minor: interest,
              principal_minor: p, balance_minor: bal}]
  return rows

schedule_to_events(debt):                    # без второго аргумента: счёт платежей и валюта — в DebtPlan (C-039)
  # «валюта debt.pay_account_id = debt.currency» здесь не проверить (счетов в аргументах нет): мультивалютный долг вне среза,
  # несовпадение даёт E_CURRENCY_MISMATCH в build_events — to_decision_events сверяет валюту события с валютой счёта
  S = debt.schedule, а если его нет — amortization_schedule по полям плана (principal_minor, rate_bp, n, start_date, kind, cadence, rounding ?? half_even)
  для row в S по k, row.payment_minor > 0:
    yield { cash_event_id: debt.debt_id + '@' + format_date(row.date), layer: planned, status: expected,
            account_id: debt.pay_account_id, date: row.date, amount_minor: −row.payment_minor, currency: debt.currency,
            kind: expense, tag: 'debt', rule_id: null, occ_key: cash_event_id, is_obligation: true, is_estimate: false, is_exceptional: false }
# сдвиг выходных не применяется: дата — договорная; перенос одного платежа — Override (ALG-01)
```

**v2: досрочное погашение и ре-якорение.** Только в день платежа (между платежами нужны накопленные проценты по договору — вне модели; `prepay` между датами платежей — `E_SCHEMA`, C-040). Обе функции принимают `DebtPlan` (нужны `rate_bp`, `kind`; график — `debt.schedule` или расчёт по полям плана, режим округления — `debt.rounding ?? half_even`). Ниже `n` — число строк текущего графика `len(schedule)`: после `shorten` оно меньше `debt.n`.

```pseudo
tail_fixed(bal, rate_bp, kind, fixed, start, k0, rounding):           # fixed: платёж (annuity) или часть долга (differential)
  rows = [];  j = 0
  пока bal > 0:
    j += 1;  i = mul_div(bal, rate_bp, 120000, rounding)
    p = kind == annuity ? min(fixed − i, bal) : min(fixed, bal)
    если p ≤ 0: fail(E_SCHEMA)                                        # платёж не покрывает проценты
    bal −= p;  rows += [{k: k0 + j, date: add_months(start, j−1), payment_minor: p + i, interest_minor: i, principal_minor: p, balance_minor: bal}]
  return rows

prepay(debt, amount, date, option):          # option ∈ {shorten, lower_payment}
  k = номер строки с row.date == date;  не найден или k == n → fail(E_SCHEMA)
  bal = debt.schedule[k−1].balance_minor − amount;  если amount ≤ 0 или bal < 0: fail(E_SCHEMA)
  если bal == 0: return debt.schedule[0..k−1]                         # погашено полностью
  next = debt.schedule[k]
  shorten:       tail = tail_fixed(bal, rate_bp, kind, kind == annuity ? debt.schedule[0].payment_minor : next.principal_minor, next.date, k, rounding)
  lower_payment: tail = amortization_schedule({principal: bal, rate_bp, n: n − k, start: next.date, kind, rounding}) со сдвигом k на +k
  return debt.schedule[0..k−1] ++ tail

reanchor(debt, k, observed_outstanding):     # после k-го проведённого платежа; срок не меняется
  k ∉ 1..n: fail(E_SCHEMA)
  modeled = debt.schedule[k−1].balance_minor;  drift = observed_outstanding − modeled
  если observed_outstanding ≤ 0 или k == n: tail = []                 # долг закрыт (при k == n и остатке > 0 — только дрейф)
  иначе: tail = amortization_schedule({principal: observed_outstanding, rate_bp, n: n − k, start: debt.schedule[k].date, kind, rounding}) со сдвигом k
  return {drift, schedule: debt.schedule[0..k−1] ++ tail}             # drift сверх допуска — предупреждение
```

Решения. **Последний платёж поглощает остаток**: сумма округлений процентов не обязана совпасть с `A`, поэтому `payment_n = balance_{n−1} + interest_n` — график всегда закрывается в 0. **Основная часть аннуитета зажата** в `[1, остаток − (n − k)]`: на малых долгах и высоких ставках ошибка округления `A` накапливается, и без зажима строка получила бы нулевую или лишнюю часть долга (пример: `P = 1642`, `n = 60`, 12 % годовых); у обычных графиков зажим ничего не меняет. **Округление процентов на каждом шаге** (`half_even`), а не по формуле «всего»: так сверяют с банком построчно. **Даты от `start`** без дрейфа (`31 января → 28 февраля → 31 марта`). **Рассрочка и 0 %** используют `split_equal`, как в REQ-044. Допуск дрейфа в `reanchor` — ключ `debt.drift_tol_bp` в `vocab.json` (значение 50 — **гипотеза**, v2; C-040). **Сдвиг выходных не применяется**: дата платежа договорная, перенос одного платежа — правка даты строки графика (C-039). Аннуитет при `rate_bp = 0` трактуется как `installment_0`; ограничения `1 ≤ n ≤ 600`, `0 ≤ rate_bp ≤ 100000`, `P ≥ n` для `annuity`/`differential` (C-041).

## Инварианты и свойства

1. `Σ principal_minor = principal`; `balance_n = 0`; баланс убывает.
2. `Σ payment_minor = principal + Σ interest_minor`.
3. Аннуитет: платежи `k < n` равны `A` (кроме строк с зажатой основной частью на малых долгах); `payment_n` отличается от `A` на накопленное округление. Оценка «не более `n` minor при `n ≤ 60`, `r ≤ 2400`» опровергнута контрпримером `P = 32443759`, `rate_bp = 2368`, `n = 57`: `A = 953130`, последний платёж 953191 (отклонение 61 minor > `n`); границу отклонения доказать не удалось.
4. `interest_k = round(balance_{k−1}·rate_bp/120000)`; при `rate_bp = 0` проценты 0.
5. Даты строго возрастают; `date_k = add_months(start, k−1)`.
6. Рассрочка: части различаются не более чем на 1, не возрастают; Σ = `total`.
7. При фиксированных `P`, `n` сумма процентов монотонно растёт с `rate_bp`.
8. `shorten`: число платежей хвоста ≤ исходного, проценты ≤ исходных; `lower_payment`: число платежей то же, платёж ≤ `A`.
9. Детерминизм: float в расчётах нет.

## Сложность

Время `O(n)` на график плюс `O(n²)` бит на `u^n` (BigInt, `n ≤ 600`); память `O(n)`. Пересчёт целиком при каждом изменении допустим.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| `rate_bp = 0` у аннуитета | график как у `installment_0` (`split_equal`) | 0 % — рассрочка |
| `n = 1` | один платёж `P + проценты периода` | `k == n` |
| `P < n` (аннуитет/дифф.) | `fail(E_SCHEMA)` | нулевые части долга |
| `P ≥ n`, но малый долг или высокая ставка (`A − interest` вне `[1, остаток − (n − k)]`) | график строится, основная часть строки зажата, платёж строки может отличаться от `A`; `fail` не нужен | накопленная ошибка округления `A`; зажим |
| `total < n` у рассрочки | часть = 0 допустима; событие с 0 не создаётся | `split_equal` |
| `start` = 31-е | даты 31→28/29→31 без дрейфа | `add_months` от `start` |
| Платёж за `horizon_end` | событие в ряд не входит; для покупки по частям — `W_PART_BEYOND_HORIZON` на каждую часть за горизонтом, `beyond_horizon_minor > 0` и оговорка «не все платежи учтены: X за горизонтом» в подписи вердикта (`check_purchase`, [ALG-04](alg-04-can-i-afford.md)); для платежей `DebtPlan` предупреждения в прототипе нет | REQ-044, C-017 |
| Платёж < процентов при `shorten` | `fail(E_SCHEMA)` | долг не гасится |
| `amount ≥ остаток` в `prepay` | `= остатку` — закрытие; `>` — `E_SCHEMA` | нет переплаты |
| `prepay` между платежами | `fail(E_SCHEMA)` | накопленные проценты по договору вне модели |
| `observed ≤ 0` в `reanchor` | хвост пуст, долг закрыт | факт важнее модели |
| Плавающая ставка, комиссии | график списком платежей, без `rate_bp` | модель их не знает |
| Валюта `debt.currency` ≠ валюте `pay_account_id` | `fail(E_CURRENCY_MISMATCH)` в `build_events` (`to_decision_events`), не в `schedule_to_events`; мультивалютный долг — вне среза | C-039 |
| Валюта платёжного счёта ≠ валюте решения | событие в валюте счёта, перевод в валюту решения — в `build_events` по [ALG-08](alg-08-fx-conversion.md) | D-20 |
| Перенос одного платежа | правка даты строки графика; сдвиг выходных не применяется | дата договорная (C-039) |

## Тест-векторы

**TV-1. Аннуитет (§9.12), `P = 120000` (1 200,00 €), 12 % годовых, `n = 6`, `start = 2026-11-01`.** `u = 121200`, `A_real = 20705,8` → `A = 20706`. Интерес `mul_div(bal, 1200, 120000)`:

| k | дата | платёж | проценты | долг | остаток |
|---|---|---:|---:|---:|---:|
| 1 | 2026-11-01 | 20706 | 1200 | 19506 | 100494 |
| 2 | 2026-12-01 | 20706 | 1005 (1004,94) | 19701 | 80793 |
| 3 | 2027-01-01 | 20706 | 808 (807,93) | 19898 | 60895 |
| 4 | 2027-02-01 | 20706 | 609 (608,95) | 20097 | 40798 |
| 5 | 2027-03-01 | 20706 | 408 (407,98) | 20298 | 20500 |
| 6 | 2027-04-01 | **20705** | 205 | 20500 | 0 |

`Σ проценты = 4235`, `Σ платежи = 5·20706 + 20705 = 124235 = 120000 + 4235`.

**TV-2. Дифференцированный, те же данные.** Части долга `split_equal(120000, 6) = [20000 ×6]`; проценты 1200, 1000, 800, 600, 400, 200 (Σ 4200); платежи 21200, 21000, 20800, 20600, 20400, 20200; остаток 100000, 80000, …, 0.

**TV-3. G-001, рассрочка без процентов (горизонт 57 дн.).** 1 100,00 € = 110000 в 6 частей с 2026-11-01: `[18334, 18334, 18333, 18333, 18333, 18333]`, Σ 110000; даты 11-01, 12-01, 2027-01-01, 02-01, 03-01, 04-01. В горизонт входит только часть 1 (5 из 6 — предупреждение `W_PART_BEYOND_HORIZON`; `beyond_horizon_minor = 91666`, 83 % суммы). `cum = 18334` со 2026-11-01: `plan` — `min free` после = `93500 − 18334 = 75166` (11-01; до 11-01 минимум 105500); `worse` — `71000 − 18334 = 52666` (11-14; 11-19 то же). При `B = 50000` запас +25166 / +2666 → вердикт `OK` ([ALG-04](alg-04-can-i-afford.md)) — по частям внутри горизонта; подпись вердикта обязана содержать «не все платежи учтены: 916,66 € за горизонтом» (C-017: оговорка неотделима от вердикта, RISK-02; решение арбитра помечено как требующее взгляда владельца).

**TV-4. G-001, дорожка 300,00 € в кредит.** `P = 30000`, 1 % в месяц, `n = 6`, `start = 2026-11-12`: `A = 5176`; строки (платёж/проценты/остаток): 5176/300/25124; 5176/251/20199; 5176/202/15225; 5176/152/10201; 5176/102/5127; **5178**/51/0. `Σ проценты = 1058`, `Σ платежи = 31058`. В горизонте один платёж (11-12): `plan` `m_after = 93500` (11-01), `worse` `71000 − 5176 = 65824` (11-14), запас +15824 → `OK`; разовая покупка той же суммы даёт `FRAGILE` (`m_after_worse = 41000`, §9.6 канона). Остальные 5 платежей — за горизонтом.

**TV-5. v2, досрочное.** После платежа 2 остаток 80793; внесено 30000 → 50793. `shorten` (платёж 20706): 20706/508/30595; 20706/306/10195; 10297/102/0 — 3 платежа, проценты 916 против 2030 (808+609+408+205). `lower_payment` (`n = 4`): `A' = 13017`; 13017/508/38284; 13017/383/25650; 13017/256 (256,5 → чётное)/12889; 13018/129/0 — проценты 1276.

**TV-6. v2, ре-якорение.** После платежа 2 банк показывает остаток 80900 против модели 80793: `drift = +107`. Хвост `n = 4`, `start = 2027-01-01`: `A' = 20733`; 20733/809/60976; 20733/610/40853; 20733/409/20529; 20734/205/0.

## Варианты и альтернативы

Календарный расчёт по дням (actual/365), эффективная ставка (APR), комиссии и страховка кредита не моделируются: расхождения с банком закрывает ре-якорение по факту (v2) или ввод платежей списком. Выбран аннуитет с `half_even` построчно и поглощением в последнем платеже: график закрывается ровно в 0 без накопления остатка.

| Продукт | Что подтверждено в материалах | Что не найдено |
|---|---|---|
| [YNAB](../tools/ynab.md) | Loan Planner — what-if только для долгов | what-if покупки в рассрочку на траектории (в изученных материалах не найдено) |
| [Firefly III](../tools/firefly-iii.md) | счета типа liability в двойной записи | график платежей (не подтверждено) |
| [hledger](../tools/plain-text-accounting.md) | периодические правила `~` (повтор платежа) | амортизация (вывод) |
| [Cashew](../tools/open-source-mobile-trackers.md) | тип операции «долг/кредит» | график |
| Budget Guru | счета включают долги ([разбор](../tools/budget-guru.md)); график и рассрочка не подтверждены | всё прочее, не проверено |

[PocketSmith](../tools/pocketsmith.md) и [Float](../tools/business-cashflow-tools.md): отдельных функций долга в изученных материалах не найдено (дата 2026-10-04).

### Не в v1

В v1 — только `installment_parts` и дробление покупки (REQ-044). График аннуитета и дифференцированный — v1.1 (проценты рассрочки — тоже). `reanchor` и `prepay` (`shorten`, `lower_payment`) — v2; прототип реализует их с тестами. Плавающая ставка, акции «отсрочка», мультивалютный долг — вне среза.

## Реализация в прототипе

**Статус: реализовано** (сверка с кодом 2026-10-04), включая v1.1 (график, `schedule_to_events`) и v2 (`prepay`, `reanchor`). Модуль `prototype/engine/debt.mjs` (зависит от `money`, `dates`; чистый: только целые, BigInt — в `annuity_payment` для `u^n` и внутри `mul_div`/`round_div`). Тест-векторы TV-1…TV-6 воспроизводятся движком до minor; цифры G-001 в TV-3 и TV-4 (`min free` 75166 и 52666, запас +25166 и +2666, `beyond_horizon_minor`, вердикты `OK` и `FRAGILE` для разовой покупки) подтверждены прогоном `check_purchase` на `analyze` по `prototype/data/g001.json`.

```js
annuity_payment(principal, rate_bp, n, rounding = 'half_even') -> Minor            // rounding ∈ { half_even, half_up } (N9)
amortization_schedule({principal, rate_bp, n, start, cadence?, kind, rounding = 'half_even'}) -> Row[]
  // Row = { k, date: EpochDay, payment_minor, interest_minor, principal_minor, balance_minor }
installment_parts(total, n) -> int[]
validate_debt(P, rate_bp, n, kind) -> undefined                   // вспомогательная; бросает E_SCHEMA / E_NOT_INTEGER
schedule_to_events(debt) -> CashEvent[]                           // v1.1; счёт и валюта — в DebtPlan (C-039)
// v2: функции принимают DebtPlan (нужны rate_bp, kind), а не только строки (C-040)
reanchor(debt, k, observed_outstanding) -> {drift, schedule}
prepay(debt, amount, date, option) -> Row[]
```

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1 и v1.1 (график, `schedule_to_events`), и v2 (`prepay`, `reanchor`). В `debt.mjs` с 2026-10-05 одно аддитивное изменение (FP-14, REQ-083): у строки графика может быть необязательное поле `extra_minor` — записанное досрочное погашение; `schedule_to_events` даёт для него второе обязательство в тот же день (`<debt_id>@<дата>#extra`), строки без `extra_minor` ведут себя как прежде. Долг, **записанный в прогноз**, — надстройка `engine/debt_ext.mjs` (FP-14, A09.3–A09.5, REQ-082, REQ-083; из `index.mjs` не реэкспортируется): `build_debt_record` (запись `DebtPlan` с сохранённым графиком — график становится источником истины), `move_row_date` (перенос платежа), `apply_prepay` (досрочное погашение: срок короче или платёж ниже), `apply_reanchor` (ре-якорение по остатку из банка), `debt_status`, `beyond_horizon_payments`, `rows_totals`, `drift_tol_bp` и `DEBT_DEFAULTS` (допуск дрейфа `debt.drift_tol_bp` читается из словаря). Платежи за горизонтом больше не молчат: `analyze` кладёт по каждому долгу служебное предупреждение `W_DEBT_BEYOND_HORIZON` (число и сумма платежей, код вне `vocab.json` — `engine/warnings_ext.mjs`). Демо: экран «Долги» — калькулятор и раздел «Долги в прогнозе» (форма «Добавить в прогноз», график, что применено, перенос платежа, досрочное погашение, сверка с банком с допуском дрейфа, «Убрать долг»); виды правок `upsert_debt`, `delete_debt`, `move_debt_row`, `apply_prepay`, `apply_reanchor` откатываются «Отменить» (`debts.mjs`, `debt_edit.mjs`, FP-09, FP-14). Рассрочка с процентами из `DebtPlan` для «Могу ли я купить» — `engine/installment.mjs` ([ALG-04](alg-04-can-i-afford.md)). **Не реализовано:** плавающая ставка, акции «отсрочка», мультивалютный долг (вне среза); пропуск платежа по долгу и выплат по потоку часов (смысл «пропустить» — вопрос владельцу, FP-36). **Открытые `todo`:** инвариант 3 (оценка накопленного округления не доказана; `adversarial/semantics`) и решение арбитра канона о зажиме основной части аннуитета (п. 1 ниже) — FP-31.

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; в скобках число тестов файла):

- `prototype/tests/debt.test.mjs` (16 тестов): TST-29 (аннуитет TV-1, даты от `start` без дрейфа, дифференцированный TV-2, дорожка TV-4, ограничения C-041, `rate_bp = 0`, v2: `prepay` TV-5 с `shorten` и `lower_payment`, полное погашение, `reanchor` TV-6), TST-30 (`installment_parts`, рассрочка G-001 TV-3), `schedule_to_events`, TST-53 (оракул аннуитета на BigInt и вещественной формуле, 1 500 случаев; детерминизм и чистота), TST-51 (свойства графиков).
- `prototype/tests/afford.test.mjs` — TST-30: `installment_parts` в `check_purchase` (`beyond_horizon_minor = 91666`, иллюстрация с первым платежом 2026-11-12); `prototype/tests/adversarial/semantics.test.mjs` — раздел «Долги и рассрочки» (метки TST-26 вместо TST-29/TST-30 из [стратегии тестирования](../product/11-testing-strategy.md)), включая `E_CURRENCY_MISMATCH` для долга в `analyze` и случаи малых долгов с зажимом; `prototype/tests/adversarial/golden_properties.test.mjs` — B-70 (независимый BigInt-расчёт).
- `prototype/tests/debt_forecast.test.mjs` (39), `debt_edit.test.mjs` (23), `debt_edit_boot.test.mjs` (15), `fp14_adv.test.mjs` (11): долг в прогнозе (FP-14) — сохранённый график, платёж в ряду «свободно», `W_DEBT_BEYOND_HORIZON`, досрочное погашение и ре-якорение с числами канона, перенос платежа (досрочное и сверка его не стирают), порядок правок, свойства на 400 + 400 случайных долгах, виды правок и «Отменить», путь от калькулятора до «Отменить» на настоящем `app.mjs` (заглушка DOM), пробы независимой проверки.
- `prototype/tests/installment.test.mjs` (7), `showcase.test.mjs` (42): рассрочка с процентами из `DebtPlan`; экран «Долги» (калькулятор и график).

**Расхождения «псевдокод ≠ код»** (после сверки; п. 1 исправлен в псевдокоде страницы):

1. Исправлено на странице: основная часть аннуитета **зажата** в `[1, остаток − (n − k)]` вместо `fail(E_SCHEMA, 'degenerate')` — график с `P ≥ n` строится всегда (на `P = 1642`, `n = 60`, 12 % прежний псевдокод бросил бы ошибку на платеже 59; в прогоне 200 000 случайных входов с `P` от `n` до 500 000 minor, `n ≤ 60`, `r ≤ 2400` он бросал ошибку в 95 случаях (≈ 0,05 %), а в остальных графики совпали построчно). Это решение кода, принятое по adversarial-находке; при зажиме платёж строки может отличаться от `A`, инвариант 3 для таких строк не выполняется — арбитру канона стоит принять зажим или вернуть `fail`. Также исправлены: проверка валюты долга делается в `build_events` (`to_decision_events`), а не в `schedule_to_events`; `rounding ∈ {half_even, half_up}` (N9); `n` в v2 — длина текущего графика; `reanchor` проверяет `k` (`E_SCHEMA`); в событии платежа есть `rule_id = null` и `occ_key`; инвариант 3 (контрпример к оценке отклонения).
2. `DebtPlan.rounding?` — поле сверх §3.8 модели данных (по умолчанию `half_even`): им пользуются `schedule_to_events`, `prepay`, `reanchor` при расчёте графика. Если у плана есть `schedule` (строки с `date` как IsoDate или EpochDay), берётся он, иначе график считается по полям плана.
3. Допуск дрейфа `debt.drift_tol_bp` в `reanchor` по-прежнему не проверяется (ключ есть в `vocab.json`, 50 — гипотеза): сравнение `|drift|` с допуском — на вызывающем. Вызывающий теперь есть: допуск читает `debt_ext.drift_tol_bp(params)`, а экран «Долги» сравнивает с ним дрейф сверки (`debt_edit.mjs`).
4. Нецелые аргументы дают `E_NOT_INTEGER` (от `assert_minor`), нарушение ограничений C-041 — `E_SCHEMA`.
5. Предупреждение `W_PART_BEYOND_HORIZON` строит `check_purchase` (`afford.mjs`) — по одному на часть `{code, part}`. **Закрыто (FP-14, REQ-082):** для платежей `DebtPlan` за горизонтом `build_events` больше не отбрасывает их молча — по каждому долгу выдаётся `W_DEBT_BEYOND_HORIZON` (`debt_id`, `count`, `total_minor`, `currency`), события за `horizon_end` в ряд по-прежнему не входят.

## Связанные страницы

- [Долги и рассрочки (понятие)](../concepts/debt-and-installments.md), [ADR-002 деньги](../decisions/adr-002-money-minor-units.md)
- [ALG-04 «могу ли я купить»](alg-04-can-i-afford.md), [ALG-03 волны](alg-03-payment-waves-detection.md), [ALG-01 правила повторения](alg-01-recurrence-expansion.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [YNAB](../tools/ynab.md)
