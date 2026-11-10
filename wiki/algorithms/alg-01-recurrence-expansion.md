---
title: "ALG-01: развёртка правил повторения"
type: algorithm
status: reviewed
summary: "Как правило повторения (D/W/M/Y, by_*, конец месяца, выходные и праздники, until/count, exdates, override) превращается в вхождения: гражданские даты, номинальная и эффективная дата, occ_key."
sources: [_ops/design-brief.md, wiki/decisions/adr-003-civil-dates.md, wiki/ideas/proposal-engine.md, wiki/tools/actual-budget.md, wiki/tools/firefly-iii.md, wiki/tools/pocketsmith.md, wiki/tools/plain-text-accounting.md]
updated: 2026-10-27
---

# ALG-01 Развёртка правил повторения и даты

## Назначение

Правило («аренда 25-го», «продукты по субботам») хранится как данные, а вхождения вычисляются на лету и не хранятся ([ADR-004](../decisions/adr-004-event-journal-projections.md)). Алгоритм отвечает на вопрос «в какие даты правило породит платёж в окне» и обслуживает Q1 (хватит ли денег к дате) и Q2 (волны платежей). Без него невозможна проекция [ALG-02](alg-02-timeline-projection.md): аренда, выпавшая на воскресенье, смещает узкую точку.

Реализует [REQ-006](../product/02-requirements.md) (гражданские даты), REQ-008 (повторение без дрейфа), REQ-009 (выходные, праздники, n-й рабочий день), REQ-010 (override по ключу); идеи IDEA-04, IDEA-05, IDEA-06; решения [ADR-003](../decisions/adr-003-civil-dates.md), [ADR-004](../decisions/adr-004-event-journal-projections.md). Тесты: TST-11…15, TST-51 ([стратегия тестирования](../product/11-testing-strategy.md)). Понятие — [правила повторения](../concepts/recurrence-rules.md).

## Определения

Термины — по [глоссарию](../product/14-glossary.md). Деньги в этой странице не считаются, кроме копирования сумм в вхождение.

- **Номинальная дата** `n` — дата вхождения до сдвигов и override. Считается **только от `start_date`**, никогда от предыдущей даты: `nominal_k = add_months(start, k·step)`, где `step = interval` (M) или `12·interval` (Y); для W без `by_weekday` — `start + 7·interval·k`; для D — `start + interval·k`.
- **Эффективная дата** `d = override(n) ?? shift_by_policy(n, weekend, calendar)`; переопределение `move` задаёт дату точно, без повторного сдвига.
- **Ключ вхождения** `occ_key = rule_id + '@' + format_date(n)`; не меняется при сдвиге, переносе и смене версии правила. Сигнатура `occ_key(rule_id_or_stream_id, nominal)`: для потока часов ([ALG-07](alg-07-hourly-income.md)) вместо `rule_id` подставляется `stream_id`; `Id` — единое пространство имён рабочей области, `rule_id` и `stream_id` не совпадают (C-025).
- **Окно** `[from, to]` фильтрует **эффективную** дату; `until_date`, `exdates`, `start_date` и `count` относятся к **номинальной**.

| Поле правила | К какой дате относится | Смысл |
|---|---|---|
| `start_date` | номинальная | `n ≥ start` |
| `until_date` | номинальная | `n ≤ until` (эффективная может быть позже) |
| `count` | порядковый номер номинальной даты после `month_end`, до `exdates` | серия не длиннее `count`; при вместе заданных `count` и `until` побеждает более ранний предел |
| `exdates` | номинальная | вхождение удаляется, но номер в `count` занимает |
| `weekend` | номинальная → эффективная | `keep`, `prev`, `next`, `skip` (дата выпадает, если не рабочий день) |
| `month_end` | день 29–31 в коротком месяце | `clamp` — последний день, `skip` — месяца нет, `next_first` — 1-е следующего |

Неделя для `by_weekday` — с понедельника; `dow`: 0 — воскресенье … 6 — суббота. `by_monthday` отрицательное — с конца месяца (−1 — последний день). `by_workday` — n-й рабочий день месяца по календарю (отрицательное — с конца). `by_monthday` и `by_workday` взаимоисключающи. Полная семантика полей `by_*`, `count`, `until_date`, `exdates` зафиксирована каноном (C-002): `by_weekday` — только при `W`; `by_monthday` и `by_workday` — только при `M`; `Y` — без `by_*`.

## Входы и выходы

| Функция (модуль) | Вход | Выход |
|---|---|---|
| `parse_date` / `format_date` (`dates`) | `IsoDate` / `EpochDay` | `EpochDay` / `IsoDate`; иначе `E_BAD_DATE` |
| `make_calendar` | `{weekend_dows: int[], holidays: IsoDate[]}` | `Calendar` с индексами и `max_shift` |
| `validate_rule` (`recurrence`) | `Rule` | `{ok, errors[{code, field, reason}]}` |
| `nominal_dates` | `Rule`, `from`, `to`: EpochDay, `cal?` — обязателен при `by_workday`, иначе `E_SCHEMA` (C-003) | `EpochDay[]`, возрастающий, без дублей |
| `effective_date` | `Rule`, `nominal`, `cal`, `overrides` — массив или индекс по `occ_key` (при повторе ключа побеждает последний, C-003) | `EpochDay` или `null` (пропуск) |
| `expand_rule` | `Rule`, `{from, to}`, `cal`, `Override[]` | `Occurrence[]`, отсортирован по `(date, amount_minor, occ_key)` |
| `expand_all` | `Rule[]`, `{from, to}`, `calendars: map`, `Override[]` | то же по всем правилам |

`Rule`, `Override`, `Calendar` — как в [модели данных](../product/04-data-model.md): `freq`, `interval ≥ 1`, `by_weekday`, `by_monthday`, `by_workday`, `start_date`, `until_date?`, `count?`, `month_end`, `weekend`, `calendar_id`, `exdates[]`, `amount{exp_minor, min_minor?, max_minor?}` (со знаком, согласован с `kind`: расход < 0, доход > 0, `exp_minor ≠ 0`; то же для `min_minor`/`max_minor`, C-001). `Override{rule_id, nominal_date, action: move|skip|set_amount, date?, amount_minor?}`.

`Occurrence = { occ_key, rule_id, nominal, date, amount_minor, amount_min_minor?, amount_max_minor?, currency, account_id, kind, is_obligation, is_estimate, tag, counterparty_id?, delay_days_worse?, reserve_id?, overridden: bool }`; даты — `EpochDay`, деньги — целые minor units.

## Алгоритм

Вспомогательные функции `money.mjs` (`floor_div`, `floor_mod`, `ceil_div`, `round_div`) — по design-brief §4; здесь деление всегда `floor_div`/`ceil_div`.

```pseudo
# ── dates.mjs: гражданская арифметика (Хиннант), 1970-01-01 = 0 ─────────────
days_from_civil(y, m, d):
  y −= (m ≤ 2 ? 1 : 0);  era = floor_div(y, 400);  yoe = y − era·400
  doy = floor_div(153·(m + (m > 2 ? −3 : 9)) + 2, 5) + d − 1
  doe = yoe·365 + floor_div(yoe, 4) − floor_div(yoe, 100) + doy
  return era·146097 + doe − 719468
civil_from_days(z):
  z += 719468;  era = floor_div(z, 146097);  doe = z − era·146097
  yoe = floor_div(doe − floor_div(doe, 1460) + floor_div(doe, 36524) − floor_div(doe, 146096), 365)
  y = yoe + era·400;  doy = doe − (365·yoe + floor_div(yoe, 4) − floor_div(yoe, 100))
  mp = floor_div(5·doy + 2, 153);  d = doy − floor_div(153·mp + 2, 5) + 1;  m = mp + (mp < 10 ? 3 : −9)
  return (y + (m ≤ 2 ? 1 : 0), m, d)
dow(d) = floor_mod(d + 4, 7)                       # 0 = воскресенье
is_leap(y) = (y mod 4 = 0 и y mod 100 ≠ 0) или y mod 400 = 0
days_in_month(y, m) = [31, is_leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m − 1]
clamp_day(y, m, day) = min(day, days_in_month(y, m))

parse_date(s):                                     # строго dddd-dd-dd
  не по шаблону → fail(E_BAD_DATE);  (y, m, d) = целые из s
  если y < 1 или m ∉ 1..12 или d ∉ 1..days_in_month(y, m): fail(E_BAD_DATE)
  return days_from_civil(y, m, d)
format_date(z): (y, m, d) = civil_from_days(z);  y ∉ 1..9999 → fail(E_BAD_DATE);  return pad4(y)+'-'+pad2(m)+'-'+pad2(d)
add_months(d, n):                                  # день берётся из ИСХОДНОЙ даты
  (y, m, day) = civil_from_days(d);  t = y·12 + (m − 1) + n
  y' = floor_div(t, 12);  m' = floor_mod(t, 12) + 1
  return days_from_civil(y', m', clamp_day(y', m', day))
add_years(d, n) = add_months(d, 12·n)              # 29 февраля → 28 февраля в невисокосном году
end_of_month(d): (y, m, _) = civil_from_days(d);  return days_from_civil(y, m, days_in_month(y, m))
diff_days(a, b) = b − a                            # > 0, если b позже a

make_calendar({weekend_dows, holidays}):
  W = множество weekend_dows ⊆ 0..6;  |W| = 7 → fail(E_RULE_INVALID, {field: 'weekend_dows'})   # нет рабочих дней
  H = sort_unique(parse_date(h) для h в holidays)
  cal = { weekend: W, holidays: set(H), max_shift: 0 }
  lo = (H пуст ? 0 : H[0]) − 14;  hi = (H пуст ? 0 : H[последний]) + 14;  run = 0
  для x в lo..hi: если not is_business(x, cal): run += 1; cal.max_shift = max(cal.max_shift, run)  иначе run = 0
  return cal                                       # max_shift — длиннейшая серия нерабочих дней подряд
is_business(d, cal) = dow(d) ∉ cal.weekend  и  d ∉ cal.holidays
next_business_day(d, cal): x = d;  пока not is_business(x, cal): x += 1;  return x      # конечен: |W| ≤ 6, H конечно
prev_business_day(d, cal): x = d;  пока not is_business(x, cal): x −= 1;  return x
shift_by_policy(d, policy, cal):
  keep → d;  next → next_business_day(d, cal);  prev → prev_business_day(d, cal)
  skip → (is_business(d, cal) ? d : null)
nth_business_day(y, m, n, cal):                    # n ≠ 0, иначе fail(E_RULE_INVALID)
  first = days_from_civil(y, m, 1);  last = first + days_in_month(y, m) − 1;  c = 0
  n > 0: для x в first..last:     если is_business(x, cal): c += 1; если c = n: return x
  n < 0: для x в last..first (вниз): если is_business(x, cal): c += 1; если c = −n: return x
  return null                                      # в месяце меньше |n| рабочих дней
```

```pseudo
# ── recurrence.mjs ───────────────────────────────────────────────────────────
validate_rule(r) -> { ok, errors[] }               # error = { code: E_RULE_INVALID, field, reason }
  freq ∈ {D,W,M,Y};  interval — int ≥ 1;  start_date, until_date?, exdates[] — валидные IsoDate;  until_date ≥ start_date
  count? — int ≥ 1;  month_end ∈ {clamp, skip, next_first} (по умолчанию clamp);  weekend ∈ {keep, prev, next, skip} (keep)
  by_weekday: только freq = W, непустое множество 0..6;   by_monthday: только freq = M, непустое, v ≠ 0, |v| ≤ 31
  by_workday: только freq = M, непустое, n ≠ 0, |n| ≤ 31, не вместе с by_monthday;   freq = Y: без by_*      # C-002
  amount.exp_minor — safe-integer ≠ 0, знак по kind (expense < 0, income > 0);  min_minor ≤ exp_minor ≤ max_minor, если заданы   # C-001: знак всех трёх по kind
  delay_days_worse? — int ≥ 0

occ_key(rule_id_or_stream_id, nominal) = rule_id_or_stream_id + '@' + format_date(nominal)    # C-025
step_months(r) = (r.freq = Y ? 12 : 1) · r.interval
week_monday(d) = d − floor_mod(dow(d) − 1, 7)

block_dates(r, s, k, cal) -> { lo, dates[] }       # блок k: день / неделя / месяц / год; dates возрастают, без дублей, ≥ s
  D: d = s + k·r.interval;  return { lo: d, dates: [d] }
  W: если r.by_weekday = null: d = s + 7·r.interval·k;  return { lo: d, dates: [d] }
     b = week_monday(s) + 7·r.interval·k
     ds = sort_unique([ b + floor_mod(w − 1, 7)  для w в r.by_weekday ])         # пн = 0 … вс = 6 в неделе блока
     return { lo: b, dates: [x для x в ds если x ≥ s] }
  M, Y:
     (ys, ms, d0) = civil_from_days(s);  t = ys·12 + (ms − 1) + k·step_months(r)
     y = floor_div(t, 12);  m = floor_mod(t, 12) + 1;  dim = days_in_month(y, m);  cand = []
     если r.by_workday ≠ null:
        для n в r.by_workday: x = nth_business_day(y, m, n, cal);  если x ≠ null: cand += [x]
     иначе: для v в (r.by_monthday ?? [d0]):                                      # без by_monthday — день старта
        v < 0:   day = dim + 1 + v;  если day ≥ 1: cand += [days_from_civil(y, m, day)]
        v ≤ dim: cand += [days_from_civil(y, m, v)]
        иначе (день 29–31 в коротком месяце): clamp → cand += [days_from_civil(y, m, dim)]
                                              skip → ничего
                                              next_first → cand += [days_from_civil(y, m, dim) + 1]
     lo = days_from_civil(y, (r.freq = Y ? 1 : m), 1)
     return { lo, dates: [x для x в sort_unique(cand) если x ≥ s] }

first_block(r, s, from):                           # с какого блока начинать; O(1), без обхода истории
  если r.count ≠ null или from ≤ s: return 0       # count требует счёта с начала серии
  D: ceil_div(from − s, r.interval)
  W: r.by_weekday = null ? ceil_div(from − s, 7·r.interval) : max(0, floor_div(from − week_monday(s), 7·r.interval))
  M, Y: delta = (год(from)·12 + мес(from) − 1) − (год(s)·12 + мес(s) − 1)
        return max(0, floor_div(delta, step_months(r)) − 1)                       # −1: next_first переносит дату вперёд

nominal_dates(r, from, to, cal):                   # cal нужен только при by_workday
  v = validate_rule(r);  не v.ok → fail(E_RULE_INVALID, v.errors)
  r.by_workday ≠ null и cal = null → fail(E_SCHEMA)                                # C-003
  s = parse_date(r.start_date);  hi = min(to, r.until_date ≠ null ? parse_date(r.until_date) : +∞)
  если hi < from или hi < s: return []
  out = [];  produced = 0;  last = −∞
  для k = first_block(r, s, from), +1, …:
     (lo, dates) = block_dates(r, s, k, cal)
     если lo > hi: return out                                                      # блоки возрастают
     для d в dates:
        если d ≤ last: continue                                                    # дубль (next_first / clamp)
        если d > hi: return out
        last = d;  produced += 1
        если r.count ≠ null и produced > r.count: return out
        если d ≥ from: out += [d]
  
effective_date(r, nominal, cal, overrides):        # overrides: массив или индекс по occ_key; повтор ключа — побеждает последний
  o = overrides[occ_key(r.rule_id, nominal)]       # массив → индекс по occ_key строится один раз, при повторе ключа остаётся последний (C-003)
  если o ≠ null: action = skip → return null;  action = move → return parse_date(o.date)      # точно, без сдвига
  return shift_by_policy(nominal, r.weekend, cal)                                  # set_amount дату не трогает

expand_rule(r, window, cal, overrides) -> Occurrence[]
  validate_rule(r) или fail(E_RULE_INVALID)
  mine = { occ_key(o.rule_id, parse_date(o.nominal_date)) → o  для o в overrides, o.rule_id = r.rule_id }   # повтор ключа — побеждает последний (C-003)
  move = max(0, |parse_date(o.date) − parse_date(o.nominal_date)| по o в mine, o.action = move)
  pad  = cal.max_shift + move            # любое вхождение с эффективной датой в окне имеет номинальную в [from − pad, to + pad]
  ex   = { parse_date(x) для x в r.exdates };  out = []
  для n в nominal_dates(r, window.from − pad, window.to + pad, cal):
     если n в ex: continue
     d = effective_date(r, n, cal, mine)
     если d = null или d < window.from или d > window.to: continue
     o = mine[occ_key(r.rule_id, n)];  amt = r.amount
     если o ≠ null и o.action = set_amount: amt = { exp_minor: o.amount_minor }   # коридор снимается
     out += [{ occ_key: occ_key(r.rule_id, n), rule_id: r.rule_id, nominal: n, date: d, amount_minor: amt.exp_minor,
               amount_min_minor: amt.min_minor, amount_max_minor: amt.max_minor, …поля правила…, overridden: o ≠ null }]
  return stable_sort(out, ключ (date, amount_minor, occ_key))                      # вхождения одного дня НЕ сливаются

expand_all(rules, window, calendars, overrides):
  для r в rules: cal = (r.calendar_id = null) ? make_calendar({weekend_dows: [0, 6], holidays: []}) : calendars[r.calendar_id]
                 нет календаря → fail(E_SCHEMA);  out += expand_rule(r, window, cal, overrides)
  return stable_sort(out, ключ (date, amount_minor, occ_key))
```

Ключевые решения. (1) Номинальные даты — от `start`, поэтому 31 января даёт 28 февраля, 31 марта, 30 апреля, а не 28→28→28 ([ADR-003](../decisions/adr-003-civil-dates.md)). (2) Окно расширяется на `pad`, потому что сдвиг выходных переносит номинальную дату через границу окна (31 октября, суббота → 2 ноября). (3) `occ_key` строится от номинальной даты: перенос меняет `date`, а не ключ, поэтому факт сопоставляется с тем же вхождением ([ALG-13](alg-13-plan-vs-actual-calibration.md)). (4) Суммирование вхождений одного дня — задача проекции ([ALG-02](alg-02-timeline-projection.md)), а не развёртки. (5) Окно развёртки для плана (от последнего якоря) выбирает построитель событий ALG-02.

## Инварианты и свойства

1. `nominal_dates` строго возрастает; каждая дата в `[max(from, start), min(to, until)]`.
2. Без дрейфа: для M/Y при `clamp` и без `by_*` `nominal_k = add_months(start, k·step)` для каждого `k`.
3. Согласованность окон: `nominal_dates(r, a, c) = nominal_dates(r, a, b) ++ nominal_dates(r, b+1, c)` и равно срезу `≥ a` от `nominal_dates(r, 0, c)` (проверяет `first_block`).
4. `|nominal_dates(r, −∞, +∞)| ≤ count`.
5. Набор `occ_key` не зависит от `weekend`, override-переносов и разбиения окна.
6. Локальность override: добавление или удаление одного override меняет только вхождение с этим ключом.
7. При `weekend = next` и без `move`: `0 ≤ d − n ≤ max_shift` и `is_business(d)`; при `prev` — симметрично.
8. `parse_date(format_date(z)) = z`, `civil_from_days(days_from_civil(y,m,d)) = (y,m,d)` для 1970–2100; `dow(d+7) = dow(d)`.
9. Детерминизм: результат не зависит от порядка правил, `Map`-обхода и часов.

## Сложность

`nominal_dates`: `O(B + K)`, где `K` — число номинальных дат в расширенном окне, `B ≤ K + пропущенные блоки` (старт — `first_block`, а не с начала истории). При заданном `count` счёт идёт с начала серии: `O(min(count, дат до to))`. `nth_business_day` — `O(31)`. `expand_all` — `O(Σ K_r + K log K)` на сортировку; память `O(K)`. Узкое место — D-правила на длинном окне и `make_calendar` (скан `O(|holidays| + 28)` один раз на календарь).

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Старт 31-го, `clamp` | 31-е, 28/29-е, 31-е, 30-е… | дата от `start`, `clamp_day` на каждый месяц |
| 29 февраля, `freq = Y` | `clamp` — 28.02 в невисокосный; `skip` — только високосные; `next_first` — 1 марта | `month_end` управляет коротким месяцем |
| `by_monthday [30, 31]` в феврале | одна дата 28-го | `sort_unique` после `clamp`, дубль не создаётся |
| 31-е, `weekend = next`, 31.10.2026 — суббота | номинальная 10-31, эффективная 11-02 | в окне ноября, поэтому `pad` |
| Цепочка праздников 25 и 28.12.2026 | `next` → 12-29, `prev` → 12-24 | сдвиг идёт до рабочего дня; `max_shift = 4` |
| `weekend = skip` на нерабочий день | вхождения нет | `effective_date = null`; номер в `count` занят |
| `by_monthday [24, 25]`, `prev`, оба на выходных | два вхождения на 10-23 | ключи разные, суммирует проекция |
| `exdates` с эффективной датой | не срабатывает, нужна номинальная | `exdates` относятся к номинальной |
| Override `move` вне окна или на дату до `start` | учитывается по `date`, ключ прежний | `pad` включает расстояние переноса |
| Override на несуществующую номинальную дату | игнорируется | ключ не совпал ни с одной номинальной датой |
| `until_date` раньше `from`, `start` позже `to` | `[]` | `hi < from` или `hi < s` |
| `by_workday` больше рабочих дней, чем в месяце | месяц без вхождения | `nth_business_day = null` |
| Календарь: все 7 дней выходные | `E_RULE_INVALID` | нет рабочего дня, сдвиг не закончится |
| Некорректная дата в `parse_date` или в override (`date`, `nominal_date`) / некорректная дата в правиле, `interval < 1`, `by_weekday` при `freq = M` | `E_BAD_DATE` / `E_RULE_INVALID` (`reason`: `bad_date`, `int_ge_1`, `only_for_W`) | валидация до расчёта: дата внутри `Rule` — ошибка правила, не `E_BAD_DATE` |

## Тест-векторы

**TV1. G-001, горизонт 57 дн. (`as_of` 2026-10-04, `horizon_end` 2026-11-30).** Правила: `R-RENT` −90000 и `R-UTIL` −12000 (M, `by_monthday [25]`, `weekend = next`), `R-PHONE` −2500 (M, [9], `next`), `R-GROC` −10000 (W, `by_weekday [6]`). Начала серий заданы каноном (design-brief §9.1, C-011): `R-RENT` и `R-UTIL` — 2026-01-25, `R-PHONE` — 2026-01-09, `R-GROC` — 2026-01-03 (суббота); на окно не влияют. Окно `[2026-10-04, 2026-11-30]`:

| Правило | Номинальные → эффективные | Шаги |
|---|---|---|
| `R-RENT`, `R-UTIL` | 10-25 → **10-26**; 11-25 → 11-25 | 10-25 — воскресенье (`dow(20751) = 0`), `next` → понедельник; 11-25 — среда |
| `R-PHONE` | 10-09, 11-09 | пятница и понедельник, сдвига нет |
| `R-GROC` | 10-10, 10-17, 10-24, 10-31, 11-07, 11-14, 11-21, 11-28 | 8 суббот |

14 вхождений; на 10-26 порядок `R-RENT` (−90000), затем `R-UTIL` (−12000); `Σ = −(180000 + 24000 + 5000 + 80000) = −289000`; с налоговым платежом −50000 (разовый план) итог −339000, как в G-001.

**TV2. Даты.** `days_from_civil(2026,10,4)`: `y = 2026`, `era = 5`, `yoe = 26`, `doy = floor_div(153·7+2, 5) + 3 = 217`, `doe = 9490 + 6 + 217 = 9713`, результат `5·146097 + 9713 − 719468 = 20730`; `dow(20730) = floor_mod(20734, 7) = 0` (воскресенье). `parse_date`: 2026-11-30 → 20787, 2027-03-15 → 20892, 2028-02-29 → 21243, 1970-01-01 → 0. Ежемесячно от 2026-01-31, `k = 0…5`: 01-31, 02-28, 03-31, 04-30, 05-31, 06-30; `k = 13`: `t = 24312 + 13 = 24325 → 2027-02`, день 31 → 28; `k = 25`: `t = 24337 → 2028-02`, день 31 → **2028-02-29**. Наивное «+1 месяц» даёт 31→28→28→28.

**TV3. Выходные, праздники, рабочие дни.** Календарь выходных [0, 6], праздники 2026-12-25 (пт) и 2026-12-28 (пн); правило M, `by_monthday [25]`, окно декабря 2026: `next` → **12-29**, `prev` → **12-24**, `keep` → 12-25, `skip` → нет вхождений; `max_shift = 4`. 3-й рабочий день ноября 2026: 11-01 воскресенье, 11-02 — 1-й, 11-03 — 2-й, **11-04** — 3-й; последний рабочий октября: 10-31 суббота → **10-30**. «Раз в 2 недели» от 2026-10-02: 10-02, 10-16, 10-30, 11-13. W, `interval 2`, `by_weekday [1, 3]` от понедельника 2026-10-05: 10-05, 10-07, 10-19, 10-21, 11-02, 11-04.

**TV4. Исключения и переопределения.** `R-GROC` с `exdates [2026-10-17]`: 7 суббот (нет 10-17). `Override{R-RENT, nominal 2026-11-25, move → 2026-11-27}`: `occ_key = 'R-RENT@2026-11-25'`, `date = 2026-11-27`; остальные вхождения прежние. Правило M от 2026-01-31 с `weekend = next`, окно ноября: номинальная 10-31 (суббота) → эффективная **11-02** попадает в окно (`pad = 2`).

## Варианты и альтернативы

| Вариант | Плюсы | Минусы | Решение |
|---|---|---|---|
| Подмножество RFC 5545 + `month_end`, `weekend`, `by_workday` (выбрано) | знакомая модель, виртуальные вхождения, `O(K)` | своя семантика расширений | выбрано |
| Cron-подобное материализованное повторение | просто | материализует реальные операции, нет «что если» | [Firefly III](../tools/firefly-iii.md): шаблон по cron создаёт реальные транзакции в срок, заранее создать нельзя |
| Накопление «+1 месяц» от предыдущей даты | тривиально | дрейф 31→28→28 | отвергнуто |
| Праздничные пакеты | меньше ввода | сеть, поддержка | в v1 только список пользователя |

Как у других (проверенные факты на страницах tools): [Actual Budget](../tools/actual-budget.md) — расписания с «каждые 2 месяца», несколькими датами, «Last day», сдвигом на выходные без праздников; [Firefly III](../tools/firefly-iii.md) — день месяца, n-й день недели, откат на последний день короткого месяца, четыре варианта выходных; [PocketSmith](../tools/pocketsmith.md) — событие с повтором, исключение «только это» правит один экземпляр, при сдвиге дат возможен двойной учёт; [hledger](../tools/plain-text-accounting.md) — периодические `~`-правила и `--forecast` с настраиваемым горизонтом; [Float](../tools/business-cashflow-tools.md) читает повторяющиеся документы из Xero/QuickBooks/FreeAgent и добавляет правила повтора и разовые записи. Праздники как данные и стабильный ключ вхождения в изученных материалах не найдены (2026-10-04; вывод).

### Не в v1

n-й день недели месяца («второй вторник», BYSETPOS), `BYMONTH`, `by_monthday` для Y, пакеты праздников с обновлением и сроком годности, версии правила с датой вступления (`valid_from`) — v2; квартальные платежи в v1 — `freq = M`, `interval = 3`.

## Реализация в прототипе

Статус — **реализовано**: модули `prototype/engine/dates.mjs` (зависит только от `money.mjs`) и `prototype/engine/recurrence.mjs` (`money`, `dates`); оба реэкспортируются из `prototype/engine/index.mjs`. Имена snake_case, как в псевдокоде; каждая функция страницы имеет одноимённый экспорт. Сверка с кодом и прогон тест-векторов TV1–TV4 и таблицы граничных случаев — 2026-10-04: числа сходятся (14 вхождений G-001, `Σ = −289000`, 10-25 → 10-26 и порядок `R-RENT`, `R-UTIL`; `days_from_civil(2026,10,4) = 20730`, шаги Хиннанта `era = 5`, `yoe = 26`, `doy = 217`, `doe = 9713`; `k = 13` → 2027-02-28, `k = 25` → 2028-02-29; 12-29 / 12-24 / 12-25 / пусто; `max_shift = 4`; 11-04, 10-30; 7 суббот без 10-17; 11-02 при `pad = 2`).

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1: `dates.mjs` с 2026-10-05 не менялся, а в `recurrence.mjs` добавлена одна функция — `validate_override(o, rule)` (Q-17, К-5): проверка правки вхождения до записи (`set_amount` — целое, не ноль, знак как у суммы правила; `move` — корректная дата), без исключений, списком `{code: 'E_SCHEMA', field, reason}`. Её зовут слой записи (`validate_ws`, `ws_edit`) и форма правила; расчёт `expand_rule` / `effective_date` на уже записанных данных поведения не меняет. Календарь и правки вхождения дошли до экрана (пакет FP-13, волна 3а, `demo/`): `form_calendar.mjs` (календарь выходных дней недели и праздников — данные пользователя, готовых списков по странам нет), `form_plan.mjs` (разовый платёж), `form_rule.mjs` (выбор календаря, «n-й рабочий день» — `by_workday`, списки дней месяца и недели, «Перенести» и «Другая сумма» для одного вхождения с предпросмотром через `expand_all`; на вхождение хранится одна правка, перенос и своя сумма вместе не совмещаются), `pack_fp13.mjs`; виды правок `upsert_calendar`, `delete_calendar`, `upsert_plan`, `delete_plan` и `set_occurrence_override` идут общим путём записи (календарь и разовый платёж — записями журнала `calendar.set` и `plan.set`; повтор той же правки вхождения второй записи не даёт) и откатываются одним «Отменить». Подпись перенесённого вхождения называет и дату со сдвигом на рабочий день, и дату по правилу (FP-48). **Не реализовано** (как и было в «Не в v1»): n-й день недели месяца (BYSETPOS), `BYMONTH`, `by_monthday` для `Y`, пакеты праздников с обновлением и сроком годности, версии правила с датой вступления (`valid_from`); в коде и в форме правила этих возможностей нет.

Реальные сигнатуры (`EpochDay` — целое число дней от 1970-01-01, `IsoDate` — `YYYY-MM-DD`):

```js
// dates.mjs
is_leap(y) -> boolean
days_in_month(y, m) -> number                          // E_BAD_DATE при m ∉ 1…12 или нецелых
clamp_day(y, m, day) -> number
days_from_civil(y, m, d) -> EpochDay                   // E_BAD_DATE, E_OVERFLOW (вне safe-integer)
civil_from_days(z) -> [y, m, d] & {y, m, d}            // E_BAD_DATE
dow(d) -> 0…6                                          // 0 = воскресенье, dow(0) = 4
parse_date(iso) -> EpochDay                            // строго dddd-dd-dd, год ≥ 1, E_BAD_DATE
format_date(z) -> IsoDate                              // годы 1…9999, иначе E_BAD_DATE
to_epoch_day(x: IsoDate | EpochDay) -> EpochDay        // сверх страницы
add_months(d, n) -> EpochDay                           // E_OVERFLOW; add_years(d, n); end_of_month(d); diff_days(a, b)
make_calendar(spec?: {weekend_dows?, holidays?}) -> Calendar   // {weekend_dows[], holidays: IsoDate[], max_shift}, заморожен
max_shift_of(cal) -> number                            // сверх страницы
is_business(d, cal) -> boolean;  next_business_day(d, cal);  prev_business_day(d, cal)
nth_business_day(y, m, n, cal) -> EpochDay | null      // n ≠ 0, иначе E_RULE_INVALID
shift_by_policy(d, policy, cal) -> EpochDay | null     // keep | prev | next | skip

// recurrence.mjs
validate_rule(rule) -> {ok, errors: [{code: 'E_RULE_INVALID', field, reason}]}     // не бросает
occ_key(rule_id_or_stream_id, nominal) -> string
nominal_dates(rule, from, to, cal?) -> EpochDay[]      // E_RULE_INVALID; E_SCHEMA — by_workday без cal
index_overrides(overrides) -> Map<occ_key, Override>   // сверх страницы
effective_date(rule, nominal, cal, overrides) -> EpochDay | null
expand_rule(rule, window, cal, overrides) -> Occurrence[]
expand_all(rules, window, calendars, overrides) -> Occurrence[]
```

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; в скобках число тестов файла):

| Файл | Что покрывает |
|---|---|
| `prototype/tests/dates.test.mjs` (16) | TST-15 (`parse_date`, `dow`, расчёт Хиннанта по шагам — TV2), TST-11 (`add_months` от 2026-01-31, `k = 0…5, 13, 25`), TST-12 (`shift_by_policy`), TST-13 (`nth_business_day`), `make_calendar` (цепочка 25 и 28 декабря, `max_shift = 4`); TST-51 — все 47 847 дней 1970–2100 против `Date`, 29 февраля, оракул `add_months` (20 000 случаев) |
| `prototype/tests/recurrence.test.mjs` (22) | TST-11 (`month_end`, `by_monthday [30, 31]`), TST-12 (`exdates`, `count`, `validate_rule`, неделя с понедельника), TST-13 (`by_workday`), TST-14 (раз в 2 недели, override по `occ_key`, перенос через границу окна, два вхождения в день), TV1, TV3, TV4, `weekend = skip`, `expand_all`; TST-51 — оракул «день за днём» на 600 правилах, инварианты 1–7 |
| `prototype/tests/adversarial/dates_money.test.mjs` (49) | состязательный набор (TST-11, 12, 14, 15, 51): все дни 0001–9999 против `Date`, дрейф конца месяца, цепочки праздников, override (последний побеждает), `validate_rule` без исключений, оракул на 2000 правил, инварианты 3, 5, 6 |
| `prototype/tests/g001.test.mjs`, `g001.golden.test.mjs` | вхождения G-001 в составе рядов TST-01 |
| `prototype/tests/purity.test.mjs` | TST-60 (часть): `dates` зависит только от `money`, `recurrence` — от `money` и `dates`; нет `Date`, часов и случайности |
| `prototype/tests/hardening.test.mjs` (40, один пропущен), `prototype/tests/small_journals.test.mjs` (11) | `validate_override` (знак, ноль и тип суммы правки вхождения — TST-14, Q-17); малые журналы и дубли дат (FP-24) |
| `prototype/tests/calendar_edit.test.mjs` (20), `override_idempotent.test.mjs` (8), `calendar_form.test.mjs` (15), `calendar_fix.test.mjs` (14), `fp13_adv.test.mjs` (9) | волна 3а, FP-13: правки календаря и разового платежа без потери условий, повтор `set_occurrence_override` не меняет `canon(ws.overrides)` и `inputs_hash`, форма правила на настоящем `app.mjs` (заглушка DOM), регрессии независимой проверки и её пробы |

**Расхождения «псевдокод ≠ код»** (смысл совпадает; при сверке 2026-10-04 код не менялся, изменения после неё — в абзаце «Состояние на 2026-10-27» выше):

1. `Calendar`. Публичный объект — `{weekend_dows[], holidays: IsoDate[], max_shift}` (отсортирован, заморожен); множества `weekend` и `holidays` из псевдокода — внутренний индекс (`WeakMap`), он строится при первом обращении и для «сырого» календаря из журнала. `spec` и его поля необязательны (по умолчанию `[0, 6]` и без праздников); `holidays` принимает `IsoDate` и `EpochDay`; значения `weekend_dows` вне 0…6 — `E_RULE_INVALID`.
2. Границы `from`/`to` в `nominal_dates` и `window` в `expand_rule`/`expand_all` — `EpochDay` или `IsoDate` (`to_epoch_day`); на странице только `EpochDay`.
3. `validate_rule` строже страницы: требует непустой `rule_id`, `kind ∈ {income, expense}`, массив `exdates`. Дата внутри `Rule` — `E_RULE_INVALID` (`reason: bad_date`); `E_BAD_DATE` бросают `parse_date`, `format_date` и даты override.
4. `effective_date` / `expand_rule`: `overrides` — массив, `Map` или объект «`occ_key` → `Override`» (`index_overrides`); неизвестное `action` или `move` без `date` — `E_SCHEMA`; при `weekend ≠ keep` без календаря — `E_SCHEMA` (`expand_rule` проверяет это независимо от окна); при `keep` и без `by_workday` календарь может быть `null`, тогда `max_shift = 0`. `expand_all`: `calendars` — объект, `Map` или массив с `calendar_id`.
5. `block_dates`: сверх страницы — защита от огромного `interval` (блок вне safe-integer считается пустым), поэтому `nominal_dates` не бросает `E_OVERFLOW`. `next_business_day` и `prev_business_day` ограничены 100 000 шагами (для допустимого календаря недостижимо).
6. `Occurrence`: `is_obligation`, `is_estimate` всегда булевы (по умолчанию `false`), `tag` по умолчанию `''`; `currency`, `account_id`, `counterparty_id`, `delay_days_worse`, `reserve_id`, `amount_min_minor`, `amount_max_minor` есть, только если заданы у правила (после `set_amount` коридора нет).
7. Экспорты сверх страницы: `to_epoch_day`, `max_shift_of`, `index_overrides`.
8. **Частично закрыто (Q-17, К-5):** `Override{action: set_amount}` по-прежнему не проверяет знак и ноль в самом расчёте (ограничения C-001 действуют на `Rule.amount`), но `validate_override` отвергает такую правку на записи (`validate_ws`, `ws_edit`, форма правила): `set_amount +5000` у правила-расхода и `0` не попадают в журнал через приложение, а в чужом файле правка уходит в карантин записей. Расчёт на уже записанных данных не изменён (решение — за арбитром канона). Сценарная `set_amount` в [ALG-02](alg-02-timeline-projection.md) знак проверяет.

## Связанные страницы

- [ALG-02: временная шкала и проекция](alg-02-timeline-projection.md) — потребитель вхождений
- [ALG-13: сопоставление план↔факт](alg-13-plan-vs-actual-calibration.md) — `occ_key`, статусы вхождений
- [ALG-03: волны платежей](alg-03-payment-waves-detection.md) — волны строятся на вхождениях
- [Правила повторения](../concepts/recurrence-rules.md), [ADR-003](../decisions/adr-003-civil-dates.md), [требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md)
