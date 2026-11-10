---
title: "ALG-07: почасовой и нерегулярный доход"
type: algorithm
status: reviewed
summary: "Ставка × минуты в плановые поступления: период и граница, лаг выплаты со сдвигом по календарю, диапазон min/ожидаемо/max, переработка, бонусы, план/факт часов и недоработка; псевдокод и векторы G-001."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/proposal-product.md, wiki/decisions/adr-002-money-minor-units.md, wiki/decisions/adr-003-civil-dates.md, wiki/tools/budget-guru.md, wiki/tools/pocketsmith.md, wiki/tools/plain-text-accounting.md, wiki/tools/business-cashflow-tools.md, wiki/tools/actual-budget.md]
updated: 2026-10-27
---

# ALG-07 Почасовой доход

## Назначение

У почасовика самое большое «может быть» в прогнозе — не расходы, а доход: сколько часов будет и когда придёт выплата. Алгоритм превращает **ставку, часы и лаг выплаты** в плановые поступления с диапазоном суммы и честной датой, а по факту часов показывает «недоработку». Вопрос Q1 (хватит ли денег к дате): доход входит в `events(d)` ([ALG-02](alg-02-timeline-projection.md)); его дата в режиме `worse` сдвигается на 14 дней ([D-04](../decisions/adr-006-forecast-semantics.md)), а сумма не уменьшается.

Реализует REQ-073…REQ-075 ([требования](../product/02-requirements.md)); идеи IDEA-18 и IDEA-42 ([движок](../ideas/proposal-engine.md), [продукт](../ideas/proposal-product.md)); определение D-19 из `_ops/design-brief.md`; деньги — целые minor units, округление `half_even` ([ADR-002](../decisions/adr-002-money-minor-units.md)), даты — календарные ([ADR-003](../decisions/adr-003-civil-dates.md)). Из поступления потока налоговый конверт берёт долю ([ALG-06](alg-06-tax-envelope.md)). Понятие — [модель почасового дохода](../concepts/hourly-income-model.md).

## Определения

- **Поток** `IncomeStream`: ставка за час `rate_minor`, `period` (`month`, `week`, `biweek`) и `cutoff` (граница периода: `kind`, `weekday?`, `anchor?`), `pay_lag_days`, `weekend`, часы `hours{min_minutes, exp_minutes, max_minutes}`, переопределения `hours_by_period`, `overtime{threshold_minutes, mult_bp}`, `bonus[]`, `pace_minutes_per_day?`. Время хранится в **целых минутах**. `cutoff.anchor: IsoDate` — дата любой границы периода (её день недели = `cutoff.weekday`), **обязательна при `period = biweek`**: без неё чётность двухнедельных периодов не определена (C-026). Поля `rounding` у потока нет — используется `params.rounding` (по умолчанию `half_even`, C-029).
- **Период** — отрезок `[start, end]`; `end` — граница. **Выплата** — `shift_by_policy(end + pay_lag_days, weekend, calendar)`; номинальная дата `end + pay_lag_days` служит ключом `occ_key`.
- `gross = mul_div(rate_minor, min(m, T)·10000 + max(0, m − T)·mult_bp, 60·10000, rounding)`, где `m` — минуты периода, `T` — порог переработки (D-19); без переработки — `mul_div(rate_minor, m, 60, rounding)`. **Одно** округление за период (C-028; формула с двумя `mul_div` отменена). `weighted_minutes = (min(m,T)·10000 + max(0, m−T)·mult_bp) / 10000` — справочная дробь, не округляется. Порог `T` относится к **периоду потока**: недельный порог при месячной выплате в v1 не выражается (нужны часы по неделям — v1.1, C-027); пример «46 ч за неделю» — только для `period = week`.
- **Диапазон**: `gross(min)`, `gross(exp)`, `gross(max)` — «min / ожидаемо / max»; в расчёте участвует `exp`, `min` — чип сценария `hours_min` (v1.1). Режим `worse` часы не уменьшает.
- **План к дате** `plan_to_date`, **недоработка** `short = plan_to_date − actual_to_date`, **эффект** `mul_div(short, rate_minor, 60)`, **оценка** `est_minutes = actual + (exp − plan_to_date)` (в v1 без `rho`, то есть `ρ = 1`). В v1 `est_minutes`/`est_gross_minor` — **отображаемая оценка**, она не меняет план; автоматическая замена `exp_minutes` по темпу — v2 (REQ-075, C-033).
- Период **закрыт**, если `end < as_of`; тогда `actual_minutes` — итог, иначе — факт «на сегодня».

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `stream` | `IncomeStream` | поля — как в design-brief §3.6; `weekend ∈ keep, prev, next` (`skip` запрещён, C-032); для `biweek` — `cutoff.anchor: IsoDate` обязательна (C-026) |
| `window` | `{from: EpochDay, to: EpochDay}` | `as_of .. horizon_end` |
| `cal` | `Calendar` | выходные и праздники пользователя |
| `as_of` | `date: EpochDay` | явная дата |
| `actual_minutes` | `minutes: int` | факт часов (журнал, `hours_by_period`) |
| `params.rounding` | `RoundMode` | по умолчанию `half_even`; единственный источник режима округления потока (C-029) |

| Выход | Тип |
|---|---|
| `gross_pay` | `Minor` |
| `period_bounds` | `{start: EpochDay, end: EpochDay}` |
| `pay_date` | `EpochDay` |
| `expand_stream` | `CashEvent[]`: `layer = planned`, `kind = income`, `amount_minor = gross(exp)`, `amount_min_minor`, `amount_max_minor`, `stream_id = stream.stream_id`, `rule_id = null` (связь с `applies_to.stream_ids` налогового правила идёт по `stream_id`, C-025), `tag = stream.name`, `occ_key = stream_id@номинальная_дата`, `delay_days_worse` |
| `planned_exp`, `resolve_hours`, `validate_stream` | вспомогательные экспорты (C-031) |
| `shortfall` | `{short_minutes, effect_minor, est_minutes, est_gross_minor}` |

## Алгоритм

```pseudo
gross_pay(rate_minor, minutes, overtime, rounding) -> Minor:
  если rate_minor < 0 или minutes < 0: fail(E_SCHEMA)
  если overtime == null: return mul_div(rate_minor, minutes, 60, rounding)
  T = overtime.threshold_minutes
  wx = min(minutes, T)·10000 + max(0, minutes − T)·overtime.mult_bp       # взвешенные минуты ×10000: точное целое, не округляется (C-028)
  return mul_div(rate_minor, wx, 600000, rounding)                         # единственное округление за период

period_bounds(stream, d) -> {start, end}:                       # период, содержащий d
  c = stream.cutoff
  month:  (c.kind == month_end)  start = days_from_civil(y, m, 1); end = start + days_in_month(y, m) − 1    # (y, m, _) = civil_from_days(d)
  week:   (c.kind == weekday)    end = d + floor_mod(c.weekday − dow(d), 7);  start = end − 6
  biweek: (c.kind == weekday, dow(c.anchor) == c.weekday)
          e = d + floor_mod(c.weekday − dow(d), 7);  если floor_mod(e − c.anchor, 14) ≠ 0: e += 7
          end = e;  start = e − 13
  иначе fail(E_SCHEMA)                                          # недопустимая пара period/cutoff

pay_date(period_end, stream, cal) = shift_by_policy(period_end + stream.pay_lag_days, stream.weekend, cal)    # weekend = skip (дата → null): fail(E_SCHEMA), доход нельзя пропустить молча (C-032)

planned_exp(stream, b) = (stream.hours_by_period[format_date(b.start)].exp_minutes) ?? stream.hours.exp_minutes

resolve_hours(stream, b, as_of) -> {min, exp, max, actual, closed}:
  o = stream.hours_by_period[format_date(b.start)] ?? {}
  h = { min: o.min_minutes ?? stream.hours.min_minutes, exp: planned_exp(stream, b), max: o.max_minutes ?? stream.hours.max_minutes }
  actual = o.actual_minutes ?? null;  closed = b.end < as_of
  если closed и actual ≠ null: return { min: actual, exp: actual, max: actual, actual, closed }       # диапазон схлопнут
  если actual ≠ null:                                           # период идёт: факт поджимает диапазон снизу
    h.min = max(h.min, actual);  h.exp = max(h.exp, actual);  h.max = max(h.max, actual)
  h.min = min(h.min, h.exp);  h.max = max(h.max, h.exp)         # exp внутри [min, max]
  return { …h, actual, closed }

expand_stream(stream, window, cal, opts = {}) -> CashEvent[]:   # opts = {rounding?, as_of?} (B2, C-029); expand_stream_ex возвращает {events, warnings}
  validate_stream(stream) иначе fail(E_SCHEMA);  GUARD = 62     # запас на сдвиг даты политикой выходных
  rate = stream.rate_minor;  ot = stream.overtime;  rounding = opts.rounding ?? half_even   # C-029: у потока своего rounding нет; значение — params.rounding вызывающего
  today = opts.as_of ?? window.from                             # окно может начинаться раньше as_of (дата якоря, C-004): «закрыт» считается от as_of
  b = period_bounds(stream, window.from − stream.pay_lag_days − GUARD);  out = []
  loop:
    если b.end + stream.pay_lag_days − GUARD > window.to: break
    nominal = b.end + stream.pay_lag_days;  pd = pay_date(b.end, stream, cal)
    если window.from ≤ pd ≤ window.to:                          # прошлые выплаты — это posted, они в opening
      hr = resolve_hours(stream, b, today)
      если hr.closed и hr.actual == null и pd ≥ today: warn(W_HOURS_NOT_CONFIRMED, b)      # закрытый период без факта — берём exp; уже оплаченные (pd < today) не предупреждают
      g = { min: gross_pay(rate, hr.min, ot, rounding), exp: gross_pay(rate, hr.exp, ot, rounding), max: gross_pay(rate, hr.max, ot, rounding) }
      если g.exp > 0:
        out.push({ cash_event_id: occ_key, layer: planned, account_id, date: pd, amount_minor: g.exp, currency, kind: income,
                   tag: stream.name, status: expected, rule_id: null, stream_id: stream.stream_id,        # C-025
                   occ_key: stream.stream_id + '@' + format_date(nominal),
                   is_obligation: false, is_estimate: false, is_exceptional: false,
                   amount_min_minor: g.min, amount_max_minor: g.max, delay_days_worse: stream.delay_days_worse })
    b = period_bounds(stream, b.end + 1)
  для x ∈ stream.bonus, window.from ≤ x.date ≤ window.to:        # дата бонуса вводится как есть, без лага и сдвига
    out.push({ …тот же шаблон, date: x.date, amount_minor: x.amount_minor, amount_min_minor: x.amount_minor, amount_max_minor: x.amount_minor,
               occ_key: stream.stream_id + '@bonus@' + format_date(x.date) })
  для k ∈ ключи stream.hours_by_period: если k — не начало периода потока: warn(W_HOURS_KEY_IGNORED, k)     # запись не применяется (опечатка в ключе)
  return sorted(out, (date, amount_minor, cash_event_id))

plan_to_date(stream, period, as_of, opts = {}) -> minutes:      # period = {start, end, exp_minutes: planned_exp}; rounding = opts.rounding ?? half_even
  days = period.end − period.start + 1
  elapsed = clamp(as_of − period.start + 1, 0, days)            # as_of входит в «прошло»
  если stream.pace_minutes_per_day ≠ null: return stream.pace_minutes_per_day · elapsed
  return mul_div(period.exp_minutes, elapsed, days, rounding)   # темп по умолчанию exp/дни, одно округление

shortfall(stream, period, as_of, actual_minutes, opts = {}) -> {short_minutes, effect_minor, est_minutes, est_gross_minor}:
  если actual_minutes < 0: fail(E_SCHEMA)
  plan = plan_to_date(stream, period, as_of, opts)
  short = plan − actual_minutes                                  # > 0 недоработка, < 0 опережение
  est = actual_minutes + max(0, period.exp_minutes − plan)       # ρ = 1; EWMA ρ — v2
  return { short_minutes: short, effect_minor: mul_div(short, stream.rate_minor, 60, rounding),
           est_minutes: est, est_gross_minor: gross_pay(stream.rate_minor, est, stream.overtime, rounding) }

validate_stream(s) -> {ok, errors[{code: E_SCHEMA, field, reason}]}:    # не бросает (expand_stream при ok == false бросает E_SCHEMA); числовые поля — целые
  rate_minor ≥ 0; 0 ≤ min ≤ exp ≤ max (и после слияния hours_by_period); pay_lag_days ≥ 0;
  (period, cutoff.kind) ∈ {(month, month_end), (week, weekday), (biweek, weekday)}; weekend ≠ skip;    # доход нельзя пропустить молча (C-032)
  period == biweek ⇒ cutoff.anchor ≠ null и dow(cutoff.anchor) == cutoff.weekday;                       # C-026
  # совпадение stream_id с rule_id (единое пространство Id, C-025) отвергает валидатор рабочей области: E_SCHEMA
  overtime: threshold_minutes ≥ 0, mult_bp ≥ 0;  bonus[i].amount_minor > 0;  pace ≥ 0
```

Решения. **Минуты, не дробные часы**: исключают накопление погрешности. **Одно округление на выплату** (C-028): `gross` — единственный `mul_div` по всей формуле, взвешенные минуты ×10000 остаются точным целым и не округляются (ADR-002, REQ-003: «округление один раз за период»); расхождение с учётом работодателя, который округляет минуты отдельно, — до `rate/120` minor на выплату (при ставке 30,00 €/ч — до 0,25 €; решение помечено арбитром как требующее взгляда владельца). **Режим округления** — `params.rounding` (C-029). **Закрытый период без факта** считается по `exp`, но с предупреждением: пользователь вводит часы, иначе «ожидаемо» остаётся планом. **`est_minutes` не переписывает план автоматически**: в v1 это отображаемая оценка, пересчёт по темпу `rho` — v2 (REQ-075, C-033); `est` показывается рядом, а принять оценку может только пользователь, записав `exp_minutes` периода. **Порог переработки** относится к периоду потока (C-027). `effect_minor` считается по базовой ставке; при переработке точнее `est_gross_minor`.

## Инварианты и свойства

1. `min ≤ exp ≤ max` для часов и `amount_min_minor ≤ amount_minor ≤ amount_max_minor` для сумм (`mul_div` неубывающий).
2. `gross_pay` не убывает по `minutes` и по `rate_minor`; без `overtime` и при `mult_bp = 10000` линейна: `gross(a) + gross(b) ≈ gross(a + b)` с точностью до 1 minor.
3. Каждый период порождает не больше одного события; `occ_key` уникален и не зависит от сдвига по выходным.
4. Все `date` событий лежат в `[window.from, window.to]`; прошлые выплаты не порождаются.
5. `worse` меняет только дату (через `eff_date`), не `amount_minor`.
6. `short = 0` при `actual = plan_to_date`; `est = exp` при `actual = plan_to_date`.
7. При закрытом периоде и темпе по умолчанию `plan_to_date = exp`, `est = actual`; при заданном `pace_minutes_per_day` `plan_to_date = pace · дни периода` и с `exp` не обязан совпадать (псевдокод не ограничивает `pace · elapsed` сверху).
8. Детерминизм: результат не зависит от порядка `bonus`, `hours_by_period`.

## Сложность

`expand_stream`: `O(P + B)`, где `P ≈ (N + 124) / длина периода` — число обработанных периодов (при горизонте 180 дней ≤ 12 для месяца и ≤ 44 для недели), `B` — число бонусов; память `O(P)`. `shortfall`, `gross_pay` — `O(1)`. BigInt — внутри `mul_div`.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Выплата до `as_of` | события нет (факт в `opening`) | план только вперёд |
| Выплата ровно в `as_of` | событие в день 0 | план на `as_of` ещё «впереди» (D-01) |
| Выплата за горизонтом | события нет | G-001: ноябрьская 2026-12-07 вне горизонта 57 дн.; при 180 дн. входит |
| Дата выплаты — выходной | сдвиг по `weekend` (`next`: суббота 12-05 → понедельник 12-07) | D-19 |
| `exp = 0` или `rate = 0` | события нет | доход должен быть `> 0` |
| Закрытый период без факта | `exp` и `W_HOURS_NOT_CONFIRMED` (если выплата не раньше `as_of`) | не выдумываем итог |
| Закрытый период с фактом | `min = exp = max = actual` | диапазон схлопнут |
| Факт «на сегодня» выше `min` | `min` поднимается до факта | часы не убывают |
| `m ≤ T` или `mult_bp = 0` | переработки нет / сверхпорог не оплачивается | формула |
| Дробная ничья при переработке (`m = 2401`, `T = 2400`, `mult_bp = 12500`, ставка 3000) | 120062,5 → `half_even` 120062, `half_up` 120063 | одно округление (C-028) |
| Недельный порог при `period = month` | в v1 не выражается | порог относится к периоду потока (C-027) |
| `period = biweek` без `cutoff.anchor` | `E_SCHEMA` | чётность периодов не определена (C-026) |
| `weekend = skip` | ошибка валидации | иначе доход исчез бы молча (C-032) |
| Февраль, 29 дней | `plan_to_date` делит на 29 | `days` из календаря |
| `pace × elapsed > exp` | недоработка завышена; предупреждения в прототипе нет (кода в реестре нет) | пользователь согласует `pace` и `exp` |
| `short < 0` | «опережение», `effect < 0` | знак сохраняется |
| Ключ `hours_by_period` не совпал с началом периода | игнорируется, предупреждение `W_HOURS_KEY_IGNORED` | опечатка в дате |
| Бонус вне окна | не включается | как плановые события |

## Тест-векторы

**TV-1. Октябрь G-001 (TST-10, TST-25), горизонт 57 дн.** Ставка 3000 (30,00 €/ч), `period = month`, `month_end`, `pay_lag_days = 5`, `weekend = next`; часы 4800 / 5580 / 6600 минут. Период 2026-10-01…10-31; `gross(5580) = mul_div(3000, 5580, 60) = 279000`, `gross(4800) = 240000`, `gross(6600) = 330000`. Выплата 31 окт + 5 = **2026-11-05** (четверг, `EpochDay` 20762), сдвиг не нужен. Событие: `planned`, `amount_minor 279000`, `[240000, 330000]`, `occ_key = S-HOURLY@2026-11-05`. Сентябрьская выплата 288000 (5760 минут) пришла 2026-10-02, до `as_of`: её номинал 09-30 + 5 = 2026-10-05 попадает в окно `expand_stream`, но плановое вхождение снимает сопоставление с фактом ([ALG-13](alg-13-plan-vs-actual-calibration.md), окно допуска 3 дня), поэтому в событиях `plan` и `worse` G-001 его нет. Ноябрь: 30 ноя + 5 = 2026-12-05 (суббота) → 2026-12-07 (20794 > `horizon_end` 20787), в горизонте 57 дн. события нет. Влияние диапазона на `close` 11-05 (было 205500): 445500 / 484500 / 535500. В `worse`: дата 2026-11-19, сумма 279000. Налоговая доля — 55800 ([ALG-06](alg-06-tax-envelope.md)).

**TV-2. Переработка (C-028, одно округление).** Период `week`, ставка 3000, `T = 2400`. При `mult_bp = 15000`: 46 ч = 2760 мин: `mul_div(3000, 2400·10000 + 360·15000, 600000) = mul_div(3000, 29400000, 600000) = 147000` (1 470,00 €; взвешенных минут 2940, G-001 не меняется). 40 ч (2400): 120000, без переработки. Минуты вне ничьей: 2401 → `24015000` → 120075 (точно), 2403 → `24045000` → 120225 (точно; прежние векторы 120100 и 120200 получались от двойного округления и отменены). **Ничья**: `m = 2401`, `T = 2400`, `mult_bp = 12500`: `mul_div(3000, 24012500, 600000) = 120062,5` → `half_even` **120062**, `half_up` **120063**.

**TV-3. Недоработка (TST-26), 2026-10-20.** `exp = 5580`, 31 день, `elapsed = 20`: `plan_to_date = mul_div(5580, 20, 31) = 3600` (темп 180 мин/день). Факт 52 ч = 3120: `short = 480` (8 ч), `effect = mul_div(480, 3000, 60) = 24000` (240,00 €); `est = 3120 + (5580 − 3600) = 5100`, `est_gross = 255000 = 279000 − 24000`. Опережение: факт 3720 → `short = −120`, `effect = −6000`, `est = 5700`, `est_gross = 285000`.

**TV-4. Закрытый и идущий период.** Октябрь закрыт (`as_of ≥ 2026-11-01`), `actual = 5700`: `min = exp = max = 5700`, сумма 285000. Нет факта — 279000 и `W_HOURS_NOT_CONFIRMED`. Период идёт, факт на сегодня 5000: `min = max(4800, 5000) = 5000` → `amount_min_minor = 250000`, остальное без изменений.

**TV-5. Периоды и бонус.** События потока несут `stream_id` (`rule_id = null`), `occ_key = S-HOURLY@2026-11-05` (C-025). `week`, граница пятница: `d = 2026-10-04` (воскресенье) → `end = 10-09`, `start = 10-03`; лаг 5 → номинал 10-14 (среда). `biweek`, `anchor = 2026-10-09`: `d = 10-12` → `e = 10-16`, `floor_mod(7, 14) ≠ 0` → `end = 10-23`, `start = 10-10`. Бонус 50000 на 2026-11-12: событие `S-HOURLY@bonus@2026-11-12`; в `worse` — 11-26.

## Варианты и альтернативы

Рассмотрены дробные часы (накопление погрешности), помесячная фиксированная сумма (не отражает вариацию часов), модель «счёт = событие» (счета вводятся по факту, а ожидания нет; сопоставление плана с фактом — [ALG-13](alg-13-plan-vs-actual-calibration.md) в окне допуска 5 % и коридоре `[amount_min, amount_max]`), пересчёт по темпу EWMA `ρ ∈ [0,5; 1,5]` (v2).

| Продукт | Что есть | Что не найдено |
|---|---|---|
| Budget Guru | заявлены ставка и норма часов; алерт «недоработка 8 ч» показан на скриншоте лендинга, инвойсы названы в политике (не подтверждено) ([разбор](../tools/budget-guru.md)) | алгоритм и лаг выплаты |
| [PocketSmith](../tools/pocketsmith.md) | приблизительные события вручную | ставки, часы, инвойсы |
| [Actual Budget](../tools/actual-budget.md) | в изученных страницах не найдено (2026-10-04) | — |
| [hledger](../tools/plain-text-accounting.md) | `timeclock`/`timedot` ведут часы | ставка и связь с деньгами в прогнозе |
| [Float](../tools/business-cashflow-tools.md) | счета с ожидаемой датой оплаты | ставки и часы |

В изученных материалах связь «ставка × часы → прогноз» не найдена ни у одного продукта (дата 2026-10-04).

### Не в v1

Автоматическая замена `exp_minutes` по темпу `rho` (EWMA, v2; в v1 — только отображаемая оценка, C-033); недельный порог переработки при месячной выплате (нужны часы по неделям, v1.1, C-027); импорт часов из CSV и чипы `hours_min` / `hours{stream_id, minutes}` (v1.1); несколько ставок в одном потоке не планируются.

## Реализация в прототипе

**Статус: реализовано** (сверка с кодом 2026-10-04). Модуль `prototype/engine/hourly.mjs` (зависит от `money`, `dates`; на `recurrence` не опирается — `occ_key` собирается здесь же; чистый, глобального `params` нет: режим округления и `as_of` приходят аргументом `opts`, §14 B2). Реализованы все функции страницы; тест-векторы TV-1…TV-5 воспроизводятся движком до minor (цифры G-001 — через `analyze` на `prototype/data/g001.json`).

```js
gross_pay(rate_minor, minutes, overtime, rounding = 'half_even') -> Minor          // overtime: { threshold_minutes, mult_bp } | null
period_bounds(stream, d) -> { start, end }
pay_date(period_end, stream, cal) -> EpochDay                                         // skip → E_SCHEMA
expand_stream(stream, window, cal, opts?) -> CashEvent[]                              // opts = { rounding?, as_of? }; as_of по умолчанию window.from
expand_stream_ex(stream, window, cal, opts?) -> { events, warnings }                  // те же события + W_HOURS_NOT_CONFIRMED, W_HOURS_KEY_IGNORED
plan_to_date(stream, period, as_of, opts?) -> minutes                                 // period.exp_minutes по умолчанию — planned_exp
shortfall(stream, period, as_of, actual_minutes, opts?) -> { short_minutes, effect_minor, est_minutes, est_gross_minor }
planned_exp(stream, b) -> minutes                                                     // вспомогательные (C-031):
resolve_hours(stream, b, as_of) -> { min, exp, max, actual, closed }
validate_stream(s) -> { ok, errors: [{ code, field, reason }] }                       // не бросает
```

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1, и часть v1.1. В `hourly.mjs` с 2026-10-05 два аддитивных изменения: `plan_to_date` при заданном `pace_minutes_per_day` не уводит план выше ожидания периода (`min(pace × elapsed, exp)`, для закрытого периода — ровно `exp`; Q-19, К-10 — это закрыло `todo` инварианта 7), а `validate_stream` называет ошибкой формы поле `bonus`, которое не массив, вместо исключения (REQ-158). Служебное предупреждение `W_HOURS_KEY_IGNORED` получило текст RU/EN и список полей в `engine/warnings_ext.mjs` (К-39: в `vocab.json` реестр кодов закрыт, поэтому код живёт в расширении); интерфейс больше не показывает для него общий текст. Из «Не в v1» уже есть v1.1: **импорт часов из CSV** — `engine/hours_io.mjs` (FP-29, A07.7: профиль «часы» как данные `hours-csv/1`, единицы `hours` / `minutes` / `hm`, часы одного потока за период складываются и заменяют записанное «отработано», дробь округляется до минуты с пометкой, сухой прогон «распознано · отклонено · дубликатов», откат партии из данных рабочей области) и в мастере импорта (`import_v11.mjs`); чипы сценария `hours{stream_id, minutes}` («часы по минимуму» и т. п.) — через `engine/scenario_ext.mjs` и конструктор сценариев (FP-07, REQ-051). Форма «Часы» («Часы и доход по ставке») — `form_hours.mjs` (FP-08). **Не реализовано:** автоматическая замена `exp_minutes` по темпу `rho` (EWMA, v2), недельный порог переработки при месячной выплате (нужны часы по неделям, C-027, A07.6), несколько ставок в одном потоке (не планируется); часы из CSV разбираются на главном потоке (файл мал), а частичный файл за уже записанный период заменяет его итог, о чём отчёт говорит до «Подтвердить».

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; в скобках число тестов файла):

- `prototype/tests/hourly.test.mjs` (23): TST-25 (`gross_pay` TV-1/TV-2 с ничьей, ошибки, оракул на BigInt в 5 000 случаев — TST-53; `expand_stream` с `exp = 0`/`rate = 0`, недельный поток, переработка), TST-10 (`period_bounds` и `pay_date` TV-5, `expand_stream` G-001 в горизонте 57 и 180 дней, бонус, `delay_days_worse`), TST-26 (`resolve_hours` и `expand_stream` TV-4, `plan_to_date`, `shortfall` TV-3), `validate_stream`, TST-51 (периоды: 1 500 потоков), TST-53 (`expand_stream` против оракула «день за днём», 400 потоков).
- `prototype/tests/g001.test.mjs` — TST-10 (G-001: 279000, коридор, аллокация 55800), TST-25/TST-26 (иллюстрации §9.2); `prototype/tests/sinking.test.mjs` — поток G-001 как источник дохода для рядов резервов; `prototype/tests/adversarial/semantics.test.mjs` — разделы `gross_pay`, `period_bounds`, `pay_date`, `expand_stream`, `resolve_hours`, `validate_stream`, `shortfall` (метки TST-25 совпадают со [стратегией тестирования](../product/11-testing-strategy.md)).
- `prototype/tests/hardening.test.mjs` (40, один пропущен): закрытие инварианта 7 — `plan_to_date` при заданном темпе (Q-19, «TST-25 ALG-07 Q-19 …»).
- `prototype/tests/hours_io.test.mjs` (14), `import_v11.test.mjs` (14), `import_v11_boot.test.mjs` (11), `scenario_builder.test.mjs` (19): импорт часов из CSV с откатом партии (мастер на настоящем `app.mjs` с заглушкой DOM), чипы сценария `hours` (FP-29, FP-07).

**Расхождения «псевдокод ≠ код»** (после сверки; п. 1–3 исправлены в псевдокоде и тест-векторе страницы):

1. `expand_stream` принимает четвёртый аргумент `opts = { rounding?, as_of? }` (B2); «закрытый период» и `W_HOURS_NOT_CONFIRMED` считаются от `opts.as_of` (по умолчанию `window.from`), потому что окно плана может начинаться раньше `as_of` (дата якоря счёта, C-004); предупреждение выдаётся только для выплат не раньше `as_of`. `plan_to_date` и `shortfall` тоже принимают `opts`.
2. TV-1: сентябрьское вхождение `S-HOURLY@2026-10-05` попадает в окно `expand_stream` (номинал 09-30 + 5); его снимает сопоставление плана с фактом 2026-10-02, а не отсутствие в `expand_stream` (прежний текст вектора это упускал).
3. **Закрыто (FP-02, Q-19, К-10), было `todo`:** при заданном `pace_minutes_per_day` `plan_to_date` теперь не выше ожидания периода: закрытый период (`as_of` позже его конца) — ровно `exp`, открытый — `min(pace · elapsed, exp)` (на тесте «200 · 31 = 6200 → 5580»). Инвариант 7 выполняется и при заданном темпе.
4. `validate_stream` не бросает, а возвращает `{ok, errors}`; `expand_stream` при `ok = false` бросает `E_SCHEMA` с этим списком. Сверх псевдокода проверяются: `stream_id` — непустая строка, `rate_minor`/`pay_lag_days`/`pace_minutes_per_day`/`delay_days_worse` — целые ≥ 0, `weekend ∈ {keep, prev, next}`, `cutoff.weekday` ∈ 0…6, корректность дат бонусов и `anchor`, `actual_minutes` ≥ 0.
5. **Частично закрыто (Q-30, К-39):** `W_HOURS_KEY_IGNORED` по-прежнему выдаётся кодом, которого нет в реестре `vocab.json` (реестр закрыт решением К-39), но у него теперь есть текст RU/EN и список полей (`stream_id`, `key`) в `engine/warnings_ext.mjs`; интерфейс показывает этот текст, а не общий.
6. Предупреждения «`pace × elapsed > exp`» в коде нет: `plan_to_date` молча ограничивает план значением `exp` (Q-19), а `shortfall` возвращает только числа; в таблице граничных случаев это отражено.

## Связанные страницы

- [ALG-06 налоговый конверт](alg-06-tax-envelope.md), [ALG-02 временная шкала](alg-02-timeline-projection.md), [ALG-01 даты и повторения](alg-01-recurrence-expansion.md), [ALG-13 план против факта](alg-13-plan-vs-actual-calibration.md)
- [Модель почасового дохода](../concepts/hourly-income-model.md), [ADR-002 деньги](../decisions/adr-002-money-minor-units.md), [ADR-003 даты](../decisions/adr-003-civil-dates.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [Budget Guru](../tools/budget-guru.md)
