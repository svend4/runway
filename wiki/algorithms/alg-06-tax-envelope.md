---
title: "ALG-06: налоговый конверт — резерв по правилу пользователя"
type: algorithm
status: reviewed
summary: "Версионируемые правила percent_of_income: аллокация при поступлении, высвобождение при платеже, true-up, срок годности; брутто/нетто и «чужие деньги». Расчёт по введённым правилам, не консультация."
sources: [wiki/decisions/adr-009-tax-rules-as-data.md, wiki/decisions/adr-016-reserves-and-safe-to-spend.md, wiki/ideas/proposal-engine.md, wiki/ideas/proposal-architecture.md, wiki/ideas/red-team-critique.md, wiki/tools/freelancer-tax-tools.md, wiki/tools/pocketsmith.md, wiki/tools/actual-budget.md, wiki/tools/plain-text-accounting.md, wiki/tools/budget-guru.md]
updated: 2026-10-27
---

# ALG-06 Налоговый конверт

## Назначение

Часть каждого поступления почасовика «не его»: её придётся отдать позже. Налоговый конверт откладывает такую часть **виртуально** в момент прихода дохода, не двигая деньги между счетами, и высвобождает её, когда пользователь вводит платёж. Так прогноз показывает не только «деньги на счёте», но и «деньги, не закреплённые под будущие платежи» (`free`, [ALG-11](alg-11-safe-to-spend.md)). Налоговые платежи — обычные плановые обязательства, поэтому они попадают в волны ([ALG-03](alg-03-payment-waves-detection.md)).

**Это расчёт по введённым пользователем правилам, не консультация.** В продукте нет ставок, сроков подачи и шаблонов стран; ассистент ставок не называет ([ADR-009](../decisions/adr-009-tax-rules-as-data.md)). Реализует REQ-062, REQ-064…REQ-068 ([требования](../product/02-requirements.md)); идеи IDEA-16, IDEA-42, IDEA-66, IDEA-97 ([движок](../ideas/proposal-engine.md), [архитектура](../ideas/proposal-architecture.md)); определения D-07, D-17 из `_ops/design-brief.md`. Именованные режимы (IDEA-17) — v2.

## Определения

- **Правило** `TaxRule` — версия данных: `tax_rule_id`, `version`, `kind = percent_of_income`, `rate_bp`, `base = gross`, `applies_to{stream_ids[], tags[]}`, `valid_from`, `valid_to?`, `rounding`, `reserve_id`, `reviewed_at?`, `ttl_days?`, `recorded_at`. Строки с одним `tax_rule_id` — версии одного правила.
- **Аллокация** `allocation = mul_div(gross, rate_bp, 10000, rule.rounding)` — одно округление на поступление; хранит `rule_version`. Смена ставки прошлое не переписывает (REQ-065).
- **Дата выбора версии правила** (C-016): для `planned`-дохода — `base(e) = max(plan_date, as_of)`, **не зависящая от режима** (`plan_date` — дата события после правок сценария и до режима, без зажима `as_of`, C-005); для `posted` — фактическая дата. Поэтому аллокации в `plan` и `worse` равны.
- **Брутто** (`gross`) — сумма поступления целиком; для потока часов это `gross_pay` ([ALG-07](alg-07-hourly-income.md)). **Нетто после резерва** — `gross − Σ аллокаций`: справочная величина, `close` и `trough` не меняются.
- **«Чужие деньги»** — часть брутто, которую пользователь передаст дальше (удержание, НДС-подобный сбор, включённый в счёт). В v1 алгоритм их не выделяет: пользователь задаёт процент, учитывающий эту часть, или заводит второе правило с другим `applies_to`. Точный разбор «сбор включён» — v2 как данные со схемой (REQ-072); справочная формула `levy = mul_div(gross, r_bp, 10000 + r_bp)`.
- **Высвобождение** `released = min(funded, |платёж|)`, `true_up = |платёж| − released` — на свободные деньги.
- **Срок годности** (C-023, X8 v1.1): `age = today − reviewed_at` в календарных днях; `fresh` при `age ≤ ttl_days`, `stale` при `ttl_days < age ≤ 2·ttl_days`, `disabled` при `age > 2·ttl_days` (REQ-067). Без `reviewed_at`/`ttl_days` — `fresh` с пометкой «проверка не отмечена».
- **Правило `disabled`** (C-024): расчёт `free` **продолжается** (аллокации и резерв остаются), в `Result.warnings` — `W_RULE_DISABLED` (для `stale` — `W_RULE_STALE`); числа, зависящие от правила (`reserved`, `free`, `STS`, вердикты Q3, `S_max`, `earliest`), интерфейс заменяет текстом «правило не подтверждено с <даты>: подтвердите или измените» через `gate` ([ALG-04](alg-04-can-i-afford.md), C-018); Q1 и волны физические — не затронуты.

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `rules` | `TaxRule[]` | все версии всех правил |
| `events` | `CashEvent[]` | события в валюте решения (проверка валюты — один раз в `build_events`, C-098): `layer`, `kind`, `date`, `plan_date`, `amount_minor`, `amount_min_minor?`, `amount_max_minor?`, `tag`, `rule_id` (для событий потока часов `rule_id = null`, вместо него `stream_id`, C-025), `reserve_id?` |
| `as_of` | `date: EpochDay` | для `base(e) = max(plan_date, as_of)` (C-016); явный аргумент, без часов |
| `d`, `known_at?` | `date: EpochDay`, `Instant` | дата дохода (для `planned` — `base(e)`, для `posted` — фактическая); `known_at` — запрос «что знали тогда» (v2) |
| `funded_minor`, `payment_minor` | `amount_minor: int` | накоплено до платежа; модуль суммы платежа (`−amount_minor`) |
| `today` | `date: EpochDay` | явный аргумент, без часов |

| Выход | Тип |
|---|---|
| `allocation_for_income` | `Minor` |
| `rule_at` | `TaxRule \| null` |
| `release_on_payment` | `{released: Minor, true_up: Minor}` |
| `allocations_for_events` | `Allocation[]`: `{allocation_id, reserve_id, date, amount_minor, source: income, source_event_id, rule_version}` — вход `reserve_series` |
| `rule_age_status` | `fresh \| stale \| disabled` |

## Алгоритм

```pseudo
validate_tax_rule(rule) -> {ok, errors[]}:                          # не бросает; errors[i] = {code, field, reason}: E_SCHEMA — только для applies_to, остальное E_RULE_INVALID
  tax_rule_id — непустая строка;  version — int ≥ 1;  valid_from (и valid_to, reviewed_at, если заданы) — корректные даты
  kind == 'percent_of_income'         # иначе E_RULE_INVALID: в v1 других видов нет
  rate_bp ∈ 0..10000 (int);  base == 'gross';  rounding ∈ {half_even, half_up, floor, ceil}
  valid_to == null или valid_to > valid_from;  reserve_id ≠ null
  applies_to.stream_ids ∪ applies_to.tags ≠ ∅      # правило «ни к чему» — ошибка валидации (C-032)
  (reviewed_at == null) == (ttl_days == null);  ttl_days == null или ttl_days ≥ 1

rule_at(rules, rule_id, d, known_at = null) -> TaxRule | null:
  C = [ r ∈ rules: r.tax_rule_id == rule_id и r.valid_from ≤ d и (r.valid_to == null или d < r.valid_to)
        и (known_at == null или r.recorded_at ≤ known_at) ]
  return C пуст ? null : argmax по (recorded_at, version) из C          # новее запись — побеждает

allocation_for_income(income_minor, rule) -> Minor:
  если income_minor < 0: fail(E_SCHEMA)
  return mul_div(income_minor, rule.rate_bp, 10000, rule.rounding)      # база — gross; округление один раз

allocation_range(e, rule) -> {min, exp, max}:                           # диапазон дохода → диапазон конверта
  return { allocation_for_income(e.amount_min_minor ?? e.amount_minor, rule),
           allocation_for_income(e.amount_minor, rule),
           allocation_for_income(e.amount_max_minor ?? e.amount_minor, rule) }       # в расчёте участвует exp

release_on_payment(funded_minor, payment_minor) -> {released, true_up}:
  если funded_minor < 0 или payment_minor < 0: fail(E_SCHEMA)
  released = min(funded_minor, payment_minor)
  return { released, true_up: payment_minor − released }               # ALG-11 применяет к сумме платежей дня

applies(e, rule) = e.kind == income и e.amount_minor > 0
                   и (e.stream_id ∈ rule.applies_to.stream_ids или e.tag ∈ rule.applies_to.tags)    # C-025: stream_id, не rule_id

base(e) = max(e.plan_date ?? e.date, as_of)                             # D-04, C-005: дата, не зависящая от режима (нет plan_date — берётся date)

allocations_for_events(events, rules, as_of) -> Allocation[]:           # as_of — для base(e), см. «Решения»
  ids = distinct r.tax_rule_id по rules, по возрастанию;  out = []
  for e in events по (plan_date, amount_minor, cash_event_id), e.layer ∈ {planned, hypothetical}:
    # валюта события = валюте решения: проверено в build_events (C-098); X4: сумма уже по spot на as_of
    A = [ r для id ∈ ids: r = rule_at(rules, id, base(e)), r ≠ null и applies(e, r) ]    # C-016: версия по base(e), не по дате режима
    если Σ r.rate_bp по A > 10000: fail(E_RULE_INVALID, { event: e.cash_event_id })       # C-032
    for r in A:
      a = allocation_for_income(e.amount_minor, r)
      если a > 0: out.push({ allocation_id: 'tax:' + r.tax_rule_id + '@' + e.cash_event_id, reserve_id: r.reserve_id,
                             date: e.date, amount_minor: a, source: income,        # date — эффективная дата режима (D-08: попадает в R_close)
                             source_event_id: e.cash_event_id, rule_version: r.version })
  return out

rule_age_status(rule, today) -> fresh | stale | disabled:               # C-023: константы 120 нет
  если rule.reviewed_at == null: return fresh                          # срок не задан: UI пишет «проверка не отмечена»
  age = today − rule.reviewed_at;  если age < 0: fail(E_BAD_DATE)
  если age ≤ rule.ttl_days: return fresh
  если age ≤ 2·rule.ttl_days: return stale                              # W_RULE_STALE
  return disabled                                                       # W_RULE_DISABLED; расчёт продолжается (C-024)

next_release(reserve_id, rs, events, as_of) -> {date, payment_minor, released_minor, true_up_minor} | null:   # факт «next_due»
  если reserve_id ∉ rs.by_reserve: return null                          # резерв не в ряду (например, привязан к счёту)
  P = [ e ∈ events: e.reserve_id == reserve_id и e.amount_minor < 0
                    и as_of ≤ e.date < as_of + len(rs.by_reserve[reserve_id].released) ];  если P пуст: return null     # только платежи внутри ряда
  d = min(e.date для e ∈ P);  i = d − as_of
  return { date: d, payment_minor: Σ |e.amount_minor| по e ∈ P с e.date == d,
           released_minor: rs.by_reserve[reserve_id].released[i], true_up_minor: rs.by_reserve[reserve_id].true_up[i] }
```

Запись в журнал при **проведённых** фактах (оболочка над теми же функциями, не часть `tax.mjs`):

```pseudo
on_posted_income(e, rules, ctx):                    # доход проведён; аллокация фиксируется со своей версией
  # версия — по фактической дате e.date (C-016); сумма в валюте решения по курсу e.date на момент записи (C-038)
  for id в distinct tax_rule_id; r = rule_at(rules, id, e.date); если r ≠ null и applies(e, r):
    a = allocation_for_income(e.amount_minor, r)
    если a > 0: журнал.add('allocation.recorded', { reserve_id: r.reserve_id, date: e.date, amount_minor: a,
                                                   source: income, source_event_id: e.event_id, rule_version: r.version })
on_posted_payment(p, funded_before_income_of_day):  # платёж привязан к резерву
  {released, true_up} = release_on_payment(funded_before_income_of_day, −p.amount_minor)
  журнал.add('allocation.recorded', { reserve_id: p.reserve_id, date: p.date, amount_minor: −released, source: release, source_event_id: p.event_id })
```

Решения. **Дата выбора версии — `base(e) = max(plan_date, as_of)`, не зависящая от режима** (C-016): в `worse` доход сдвигается, но версия правила выбирается по плановой дате, поэтому аллокации в `plan` и `worse` равны, а при `Σ rate_bp ≤ 10000` свойство «`free_worse ≤ free_plan`» ([ALG-11](alg-11-safe-to-spend.md), инвариант 8; [ALG-04](alg-04-can-i-afford.md), инвариант 3) выполняется безусловно; прежнее допущение «версия по сдвинутой дате» отменено. Для `posted`-дохода — фактическая дата. Так как `base(e)` требует `as_of`, у `allocations_for_events` третий аргумент (в таблице сигнатур канона — `(events, rules)`; расхождение передано арбитру как открытый вопрос — `as_of` берётся из контекста `analyze`). **План не пишется в журнал**: аллокации по `planned` считаются на лету, по `posted` — фиксируются записью со `rule_version`; при сопоставлении план→факт аллокация пересчитывается от фактической суммы по курсу факта (X4, C-038). **Порядок дня**: платёж высвобождает резерв до аллокаций того же дня (D-08). **Квартальный платёж** — правило повторения ([ALG-01](alg-01-recurrence-expansion.md)) с `reserve_id` и суммой пользователя; сроков и сумм в коде нет. **`disabled`** (C-024): расчёт `free` продолжается (иначе резерв исчез бы и вердикт стал оптимистичнее), в `Result.warnings` — `W_RULE_DISABLED`; зависящее число скрывается интерфейсом через `gate` с пометкой «правило не подтверждено с <даты>: подтвердите или измените» (скрытие показа, а не вычисления; решение арбитра помечено как требующее взгляда владельца). **Срок годности** — одна формула `2·ttl` (C-023; константа `STALE_GRACE_DAYS = 120` и «ttl + 120» из прежней версии X8 отменены). Каждое число с налоговой оговоркой: «расчёт по введённым правилам, не консультация».

## Инварианты и свойства

1. `0 ≤ allocation ≤ income` при `rate_bp ≤ 10000`; монотонность по доходу и по `rate_bp`.
2. Для событий одного дня сумма аллокаций не зависит от порядка событий и правил.
3. `released + true_up = payment_minor`, `0 ≤ released ≤ funded`.
4. Правка правила или добавление версии не меняет сохранённые аллокации и `state_hash` прошлых записей (`rule_version`).
5. Нет применимого правила — нет аллокации; аллокации не меняют `close` и `trough` (REQ-060).
6. `allocation_range`: `min ≤ exp ≤ max` при неубывающем `mul_div`.
7. Детерминизм: порядок `rules`, `events` не влияет; `rule_at` не читает часы.
8. `rule_age_status` монотонно проходит `fresh → stale → disabled` с ростом `today`; границы `ttl` и `2·ttl`, без скрытых констант (C-023).
9. Аллокации (суммы и версии) в `plan` и `worse` совпадают для одного события (версия — по `base(e)`, C-016); при `Σ rate_bp ≤ 10000` отсюда безусловно `free_worse ≤ free_plan`.

## Сложность

`allocations_for_events`: `O(E·V)` по числу доходных событий `E` и версий правил `V` (на практике `V ≤ 10`, `E ≤ 20` в горизонте); память `O(E)`. Остальные функции — `O(1)` или `O(V)`. BigInt — только внутри `mul_div`.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Ни одно правило не применимо | аллокаций нет, `free` без конверта | нет ставок по умолчанию (REQ-068) |
| `rate_bp = 0` | аллокация 0 не выводится | пауза правила |
| `d = valid_from` / `d = valid_to` | включается / не включается | `valid_from ≤ d < valid_to` |
| Версии пересекаются | побеждает наибольшее `recorded_at`, затем `version` | D-17 |
| Дата дохода раньше всех `valid_from` | `rule_at = null`, аллокации нет, предупреждение | прошлого не выдумываем |
| Новая версия «задним числом» | прошлые `posted`-аллокации неизменны; `planned` считаются по новой | `rule_version` |
| Два правила на одно поступление, Σ ставок > 10000 | `E_RULE_INVALID` на событии | аллокаций больше дохода (C-032) |
| Ставка сменилась между `plan_date` и сдвинутой датой `worse` | в обоих режимах версия по `base(e)`; аллокации равны | C-016 |
| Правило с пустым `applies_to` | ошибка валидации (`E_SCHEMA`) | C-032 |
| Совпадение `rule_id` и `stream_id` в рабочей области | `E_SCHEMA` на валидаторе | единое пространство `Id` (C-025) |
| Платёж больше накопленного | `released = funded`, `true_up` — на свободные деньги | D-07 |
| Платёж при пустом резерве | `released = 0`, `true_up` = весь платёж | `min(0, …)` |
| Доход в чужой валюте | база — сумма в валюте решения: `planned` — `spot` на `as_of`, `posted` — курс даты факта в момент записи `allocation.recorded`; резерв «заморожен», не переоценивается; при сопоставлении план→факт пересчёт от фактической суммы | X4, C-038 |
| Отрицательное поступление (возврат) | не аллоцируется; `revert` исходного дохода снимает его аллокацию | `amount_minor > 0` в `applies` |
| `disabled` (`age > 2·ttl`) | расчёт продолжается, `W_RULE_DISABLED`, зависящие числа скрыты гейтом | C-024 |
| `reviewed_at` в будущем | `E_BAD_DATE` | осторожность |
| Правило без `reviewed_at`/`ttl_days` | `fresh`, пометка «проверка не отмечена» | C-023 |
| `hypothetical` доход сценария | получает аллокацию | сценарий честен про конверт |

## Тест-векторы

**TV-1. Октябрьская выплата G-001 (TST-10, горизонт 57 дн.).** Правило `TR-20`: версия 1, 2000 bp, `valid_from 2026-01-01`, `half_even`, `applies_to.stream_ids = [S-HOURLY]`, `reserve_id = RES-TAX`. Событие `S-HOURLY@2026-11-05` +279000: `mul_div(279000, 2000, 10000) = 55800`. Аллокация `{reserve: RES-TAX, date: 2026-11-05, amount: 55800, rule_version: 1}`; в `reserve_trough` 11-05 не входит, в `reserve_close` — да: `RES-TAX = 150000 − 50000 + 55800 = 155800`, `RES-INS = 12000`, Σ 167800. В `worse` та же аллокация на 2026-11-19. Нетто после резерва `279000 − 55800 = 223200`. Диапазон часов: `min` 240000 → 48000, `max` 330000 → 66000. Сентябрьская выплата 288000 → 57600 уже в `funded_start`.

**TV-2. Округление (TST-23).** `mul_div(123457, 2100, 10000, half_even) = 25926` (259,2597 € → 259,26 €). Ничья: `4900 · 2250 / 10000 = 1102,5`: `half_even` 1102, `half_up` 1103, `floor` 1102, `ceil` 1103.

**TV-3. Версии (TST-24).** v1: 2000 bp с 2026-01-01; v2: 2200 bp с 2026-07-01 (записана позже). Доход 300000: 2026-06-30 → v1 → 60000; 2026-07-01 → v2 → 66000; 2026-07-02 → v2 → 66000. Версия v3 «2200 bp с 2026-05-01», введённая 2026-10-04: проведённая аллокация за 2026-05-15 (60000, `rule_version 1`) не меняется; расчёт на ту же дату по v3 дал бы 66000; при `known_at = 2026-09-01` (запрос «что знали тогда», в продукте v2) выбрана версия 1.

**TV-4. Высвобождение (TST-24).** `funded 150000`, платёж 50000 → `released 50000`, `true_up 0`. `funded 30000` → `30000` и `20000`. `funded 0` → `0` и `50000`. G-001, `P-TAX1` 2026-10-23: `reserve_trough` 150000 → 100000, `trough` 377500 → 327500, `free` 227500 до и после платежа; `next_release(RES-TAX, …) = {2026-10-23, 50000, 50000, 0}`. При `funded_start = 30000` `free` падает 347500 → 327500 на `true_up = 20000` ([ALG-11](alg-11-safe-to-spend.md), TV-5).

**TV-5. Срок годности (REQ-067, C-023).** `reviewed_at = 2026-10-04`, `ttl_days = 120`: 2027-02-01 (`age 120`) — `fresh`; 2027-02-02 (121) — `stale`; 2027-06-01 (240 = `2·ttl`) — `stale`; 2027-06-02 (241) — `disabled`. Для `ttl_days = 90`: `disabled` с 2027-04-03 (`age 181`).

**TV-7. Версия по `base(e)` (C-016, синтетика).** v1: 2000 bp до 2026-11-10 (`valid_to`), v2: 2200 bp с 2026-11-10. Событие потока +279000 с `plan_date = 2026-11-05`, `as_of = 2026-10-04`; в `worse` эффективная дата 2026-11-19. Версия выбирается по `base(e) = 2026-11-05` → v1 в обоих режимах: аллокация 55800 в `plan` (дата 11-05) и в `worse` (дата 11-19), а не 61380 (`mul_div(279000, 2200, 10000)` по v2, как давала прежняя привязка к сдвинутой дате). Для `posted`-дохода на 2026-11-12 — v2 по фактической дате.

**TV-6. Справочно (v2).** Условный сбор 1000 bp включён в счёт 110000: `mul_div(110000, 1000, 11000) = 10000`; приближение процентом от `gross` (909 bp) даёт 9999 — разница 1 minor.

## Варианты и альтернативы

Рассмотрены зашитые правила стран, шаблоны с окнами подачи, плагины-скрипты и внешний API ставок — отвергнуты в [ADR-009](../decisions/adr-009-tax-rules-as-data.md) (устаревание, ответственность за «совет», исполняемый чужой код, сеть). Выбраны версионируемый процент и платежи пользователя: честно и проверяемо.

| Продукт | Что есть | Что не найдено |
|---|---|---|
| Found, Profit First | автоматический откладываемый «карман» и метод процентов от поступлений ([налоги фрилансеров](../tools/freelancer-tax-tools.md)) | связь с прогнозом остатка |
| Hurdlr, QuickBooks | оценка налога по ходу года (у Hurdlr — по проекции дохода текущего года) | платёж в общем графике волн |
| [PocketSmith](../tools/pocketsmith.md) | обходной путь: ручной перевод процента на отдельный счёт | нативные правила |
| [Actual Budget](../tools/actual-budget.md) | автоматизация «процент от дохода» без правил по датам | версии, платежи, `true_up` |
| [hledger](../tools/plain-text-accounting.md) | авто-проводки с процентом, без правил по датам | высвобождение и срок годности |
| [Firefly III](../tools/firefly-iii.md) | налогового конверта нет | — |
| Budget Guru | «правила по датам» заявлены, механика не показана (не подтверждено) ([разбор](../tools/budget-guru.md)) | не проверено |

### Не в v1

Именованные режимы (накопительный аванс от прибыли с начала года, чистый НДС-подобный сбор), `base = net_of_vat`, окна дат и шаблоны стран — v2, только как данные со схемой, проверкой и сроком годности (REQ-072); `known_at` в интерфейсе — v2; переоценка резерва в валюте платежа — v2; привязка резерва к счёту — v1.1.

## Реализация в прототипе

**Статус: реализовано** (сверка с кодом 2026-10-04; обновлено 2026-10-27) для модуля `prototype/engine/tax.mjs` (зависит от `money`, `dates`; чистый, ставок и сроков в коде нет; с 2026-10-05 модуль не менялся — совпадает со снимком построчно). Оболочки `on_posted_income` и `on_posted_payment` по замыслу вне `tax.mjs`; при первой сверке их не было, с волны 1 они есть в `prototype/engine/tax_hooks.mjs` (FP-08, REQ-064, REQ-065) — см. абзац «Состояние на 2026-10-27» ниже. Тест-векторы TV-1…TV-7 воспроизводятся движком до minor (цифры G-001 — через `analyze` на `prototype/data/g001.json`).

```js
validate_tax_rule(rule) -> { ok, errors: [{ code, field, reason }] }          // не бросает
rule_at(rules, rule_id, d, known_at?) -> TaxRule | null
allocation_for_income(income_minor, rule) -> Minor
allocation_range(e, rule) -> { min, exp, max }                       // вспомогательная
release_on_payment(funded_minor, payment_minor) -> { released, true_up }
allocations_for_events(events, rules, as_of) -> Allocation[]         // версия по base(e), C-016; as_of обязателен (без него E_BAD_DATE); в таблице канона — (events, rules), см. «Решения»
rule_age_status(rule, today) -> 'fresh' | 'stale' | 'disabled'       // ttl / 2·ttl, C-023
next_release(reserve_id, rs, events, as_of) -> { date, payment_minor, released_minor, true_up_minor } | null   // вспомогательная
```

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1, включая оболочки, которых при первой сверке не было. Движок: `engine/tax_hooks.mjs` (надстройка над `tax.mjs`, из `index.mjs` не реэкспортируется) — `on_posted_income(state, fact, ctx)` (проведённый доход → аллокации `source = income` по версии правила на фактическую дату факта, сумма в валюте решения по курсу даты факта, C-016, C-038), `on_posted_payment(state, fact, ctx)` (платёж, привязанный к резерву → запись `source = release` со знаком минус: `released = min(накоплено, платёж)`, `true_up = платёж − released`), `pending_posted_allocations(ws)` (какие проведённые доходы и платежи ещё не оставили записей), идентификаторы `tax:<tax_rule_id>@<event_id>` и `rel:<reserve_id>@<event_id>` (повтор записи не дублирует). Модуль возвращает заготовки записей `allocation.recorded`; пишет их слой ввода (`demo/`). Демо: форма «Налог» с проверкой правила и предпросмотром (`form_tax.mjs`, FP-08), кнопка «Записать в конверт» и форма «Выплата получена»; срок годности правила на экране — плашка «не подтверждено с <даты>» и «Подтвердить правило» (`rule_age.mjs`, FP-15), числа резерва под отключённым (`disabled`) правилом заменены текстом, в том числе на «Обзоре» (FP-15, FP-47, C-024); «Как посчитано» — поступление → правило и версия → формула `mul_div` → сумма (`alloc_explain.mjs`, FP-15); «следующее списание из конверта» в карточке налога по `next_release` (FP-28). Ставок и шаблонов стран в приложении нет: ставку вводит пользователь (сканер `no_default_rates` проверяет код и данные). **Не реализовано:** именованные режимы (накопительный аванс, НДС-подобный сбор), `base = net_of_vat`, окна дат и шаблоны стран (v2, юридически чувствительно, ждут решения владельца и ревью), `known_at` в интерфейсе (v2), переоценка резерва в валюте платежа (v2). Доход, введённый быстрым вводом «+ Факт», в конверт сам не записывается: запись делает форма «Выплата получена» или кнопка «Записать в конверт»; как связывать такой доход с правилом — вопрос владельцу (FP-35). Юридическое ревью формулировок о налогах (REQ-183, критерий остановки № 5) не выполнено; пакет для ревью собирается из кода (`tools/people_pack.mjs legal`).

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; в скобках число тестов файла):

- `prototype/tests/tax.test.mjs` (18 тестов): TST-23 (`allocation_for_income`, ничьи округления, свойства на 3 000 случаев), TST-10 (`allocation_range`, TV-1 G-001, Σ аллокаций в `reserve_close`), TST-24 (версии TV-3, `valid_to`, `known_at`, `release_on_payment` TV-4, `next_release`, `validate_tax_rule`, TV-7 по `base(e)`, `allocations_for_events`, C-032), TST-57 (`rule_age_status`, TV-5), TST-33 (часть, детерминизм).
- `prototype/tests/sinking.test.mjs` — G-001 в связке `allocations_for_events` → `reserve_series` (TST-02, TST-24); `prototype/tests/g001.test.mjs` — TST-02/TST-08 (аллокация по `base(e)`, равенство `plan` и `worse`), TST-10; `prototype/tests/adversarial/semantics.test.mjs` — `rule_at`, `allocation_range`, `release_on_payment`, `validate_tax_rule`, `allocations_for_events`, `rule_age_status`, `analyze` с правилом `disabled` (метки TST-24 там совпадают со [стратегией тестирования](../product/11-testing-strategy.md)).
- `prototype/tests/tax_hooks.test.mjs` (11): запись по проведённому доходу и платежу, идемпотентность по `allocation_id`, `pending_posted_allocations` (FP-08, TST-23, 24).
- `prototype/tests/reserve_screen.test.mjs` (36), `overview_masked.test.mjs` (8), `no_default_rates.test.mjs` (7): срок годности правила и «Подтвердить правило», «Как посчитано» на четырёх наборах G-001, при `disabled` на экране нет числа 558,00 и остатков конверта, 0 предзаполненных ставок и шаблонов стран (FP-15, FP-47, FP-25).
- Мутации ядра: у `tax.mjs` 9 порч, все убиты тестами модуля; замок вывода движка заметил 2, golden — 1, property-тесты — 1 (`../_ops/mutation.json`, раздел `engine`, `tools/mutate.mjs --catalog engine`).

**Расхождения «псевдокод ≠ код»** (после сверки; п. 1 исправлен в псевдокоде страницы):

1. Исправлено на странице: форма результата `validate_tax_rule` (`{ok, errors[{code, field, reason}]}`, функция не бросает) и проверки `tax_rule_id`, `version`, дат; `base(e)` без `plan_date` берёт `date`; `next_release` возвращает `null`, если резерва нет в `rs.by_reserve`, и учитывает только платежи внутри ряда `as_of … horizon_end`.
2. `allocations_for_events(events, rules, as_of)`: у третьего аргумента нет значения по умолчанию (прежняя запись `[, as_of]` была неверна). Расхождение с таблицей канона `(events, rules)` остаётся открытым вопросом арбитра ([аудит сигнатур](../../_ops/signature-audit.md), «Нерешённое» № 1).
3. `allocation_for_income`: если у правила нет `rounding`, берётся `half_even` (валидатор поле требует; значение по умолчанию — защита).
4. `rule_at`: `recorded_at` сравнивается как Instant `YYYY-MM-DDThh:mm:ss[.f]Z` с дополнением доли секунды до 9 знаков (иначе — как строка или число), отсутствующий `recorded_at` считается самым ранним; в псевдокоде это не оговорено.

## Связанные страницы

- [ADR-009 налоговые правила как данные](../decisions/adr-009-tax-rules-as-data.md), [ADR-016 резервы](../decisions/adr-016-reserves-and-safe-to-spend.md), [налоговый конверт (понятие)](../concepts/tax-envelope.md), [движок налоговых правил](../product/08-tax-rules-engine.md)
- [ALG-11 safe-to-spend](alg-11-safe-to-spend.md), [ALG-05 sinking funds](alg-05-sinking-funds.md), [ALG-07 почасовой доход](alg-07-hourly-income.md), [ALG-03 волны](alg-03-payment-waves-detection.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [налоги фрилансеров](../tools/freelancer-tax-tools.md)
