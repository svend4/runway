---
title: "ALG-08: курсы валют и конвертация"
type: algorithm
status: reviewed
summary: "Суммы хранятся в валюте счёта; в валюту решения переводятся по ручному курсу spot через BigInt; курс обмена выводится из двух ног; сценарий курса и крипта. Псевдокод, инварианты, тест-векторы."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/proposal-product.md, wiki/ideas/red-team-critique.md, wiki/decisions/adr-012-fx-rate-policy.md, wiki/tools/pocketsmith.md, wiki/tools/actual-budget.md, wiki/tools/firefly-iii.md, wiki/tools/plain-text-accounting.md, wiki/tools/business-cashflow-tools.md, wiki/tools/modern-saas-trackers.md]
updated: 2026-10-27
---

# ALG-08 Курсы валют и конвертация

## Назначение

Вердикты Q1 и Q3 — скаляры в одной валюте, а остатки релоканта — вектор EUR/USD/RUB/крипта. Алгоритм вводит **валюту решения** и переводит в неё всё, что попадает в ряд (`trough`, `free`, волны, `STS`), не теряя копеек и не подменяя курс «операции» курсом «прогноза» (C15 в `_ops/design-brief.md`, D-20).

Реализует REQ-077…REQ-081 ([требования](../product/02-requirements.md)), идеи IDEA-19, IDEA-20, IDEA-50 ([предложение по движку](../ideas/proposal-engine.md)), решение [ADR-012](../decisions/adr-012-fx-rate-policy.md); деньги — [ADR-002](../decisions/adr-002-money-minor-units.md). Понятие — [мультивалютность](../concepts/multi-currency-fx.md). Вызывается из [ALG-02](alg-02-timeline-projection.md) (шаг «валюта решения»); покупка в чужой валюте переводится до [ALG-04](alg-04-can-i-afford.md).

## Определения

- **Сумма в валюте счёта**: `CashEvent.amount_minor` + `currency` счёта; пересчёт — только на границе ряда.
- **Курс** `FxRate{base, quote, num, den}`: 1 основная единица `base` = `num/den` основных единиц `quote`. Хранится без float **как введён**: «0,9250» — `9250/10000`, без сокращения; производные курсы (`implied_rate`, `apply_shock`) — несократимая дробь (`gcd`; детерминизм `canon` и `inputs_hash`, C-037). Обратная пара допускается (`rate_at` переворачивает дробь, C-036).
- **Курс операции** — наблюдаемый: `implied = leg_b / leg_a` из двух ног обмена. Он не вводится и в прогноз не идёт.
- **Курс прогноза (`spot`)** — последний введённый курс пары с датой `≤ as_of`; применяется ко всем будущим событиям одинаково. Подпись в UI: «курс 0,9250 от 2026-10-04» (REQ-079). Срок давности курса — параметр `fx.stale_days = 30` (гипотеза, §2.0, настраивается в `Workspace.params`, C-096): старше — плашка, расчёт не блокируется.
- **Сценарий курса** `fx_shock{currency, bp}` (v1.1): курс пары × `(10000 + bp)/10000`.
- **Курсовая разница обмена** — справочно: сколько `spot` дал бы за проданную ногу минус полученная нога; в `trough` не входит.
- **Ликвидность крипты** — доля `liquidity_bp/10000` оценки, по умолчанию 0 (C13).
- Формула: `convert_minor(a, base_exp, quote_exp, num, den, mode) = round_div(a · num · 10^quote_exp, den · 10^base_exp, mode)`; округление — **один раз на событие**, режим `rounding` (`half_even`).

| | Курс операции | Курс прогноза |
|---|---|---|
| Откуда | две ноги факта | ручной ввод `FxRate` |
| Куда применяется | справочно, подпись обмена | будущие события, остатки, запас |
| Меняется при пересчёте | нет | да, при новом вводе курса |

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `events` | `CashEvent[]` | события в валюте счёта (`amount_minor:int`, `currency`, `transfer_id?`) |
| `accounts` | `Account[]` | `currency`, `exponent`, `kind`, `liquidity`, `liquidity_bp` |
| `rates` | `FxRate[]` | `fx_id`, `date: EpochDay`, `base`, `quote`, `num:int`, `den:int` |
| `decision_currency`, `as_of` | `Currency`, `EpochDay` | валюта решения; дата `spot` |
| `policy` | `'spot'` или `{kind:'spot', as_of, shock?:{Currency→Bp}, rounding?}` | `normalize_policy` приводит строку к записи; `as_of` — отдельным аргументом. ALG-02 вызывает `to_decision_events(…, 'spot', as_of)` и `opening_in_decision` (C-034) |
| `ctx` | `{rates, decision_currency, policy, rounding}` | контекст `to_decision`, `opening_in_decision`, `liquid_value` (C-034); `to_decision` нормализует `policy` сам, `liquid_value` читает дату из `ctx.policy.as_of` (нужна запись, а не строка) |

| Выход | Тип |
|---|---|
| `to_decision_events` | `CashEvent[]` в валюте решения + служебные `orig_amount_minor`, `orig_currency`, `rate_used{num,den,date}` (в журнал не пишутся) |
| `convert_minor`, `liquid_value` | `Minor` |
| `implied_rate`, `apply_shock` | `{num:int, den:int}` (несократимая дробь, `gcd`) |
| `rate_at` | `{num, den, date, inverse} \| null` |
| `to_decision`, `opening_in_decision` | `{amount_minor, rate}`; `Minor` |
| `exchange_difference`, `rate_status`, `normalize_policy` | `Minor`; `{age, stale}`; запись политики (экспорты `fx.mjs`, C-035) |

Зависимости: `money` (`assert_minor`, `round_div`, `sum_minor`, `currency_exponent`, `gcd` — добавлена в `money.mjs`, C-037), `dates`.

## Алгоритм

```pseudo
convert_minor(a, base_exp, quote_exp, num, den, mode = half_even):
  assert_minor(a)
  если num ≤ 0 или den ≤ 0 (не целые): fail(E_SCHEMA);  base_exp, quote_exp — целые ≥ 0
  n = BigInt(a) · BigInt(num) · 10^quote_exp;   d = BigInt(den) · 10^base_exp      # произведение может быть > 2^53
  r = round_div(n, d, mode)                                                       # d > 0
  если |r| > 2^53 − 1: fail(E_OVERFLOW);  return r

normalize_policy(policy, as_of):                  # строка 'spot' → запись; идемпотентна
  p = policy == 'spot' ? {kind: 'spot', as_of} : policy
  если p.kind ≠ 'spot': fail(E_SCHEMA)            # native / adverse — v2
  r = {shock: {}, rounding: half_even, ...p};  r.as_of = EpochDay(r.as_of)       # нет даты — E_BAD_DATE
  rounding ∈ {half_even, half_up, floor, ceil};  каждый r.shock[cur] — целое, 10000 + bp > 0      иначе fail(E_SCHEMA)
  return r

rate_at(rates, base, quote, d, policy):           # d = as_of; policy уже нормализована (в коде аргумент зарезервирован и не читается)
  если base == quote: return {num: 1, den: 1, date: d, inverse: false}
  c = max(r ∈ rates: r.date ≤ d, r.base == base, r.quote == quote)      по (date, fx_id; при равных — num, den)
  i = max(r ∈ rates: r.date ≤ d, r.base == quote, r.quote == base)      по (date, fx_id; при равных — num, den)
  если c == null и i == null: return null
  если i == null или (c ≠ null и c.date ≥ i.date):   # при равной дате прямой курс побеждает
     return {num: c.num, den: c.den, date: c.date, inverse: false}
  return {num: i.den, den: i.num, date: i.date, inverse: true}       # обратная пара: дробь переворачивается
                                                    # триангуляции через третью валюту в v1 нет

implied_rate(leg_a, leg_b, base_exp, quote_exp):    # модули ног в minor; a — проданная, b — полученная; экспоненты обязательны (C-034): без них курс неверен при разных экспонентах
  если leg_a ≤ 0 или leg_b ≤ 0: fail(E_SCHEMA)
  n = BigInt(leg_b) · 10^base_exp;  d = BigInt(leg_a) · 10^quote_exp;  g = gcd(n, d)
  return {num: n / g, den: d / g}                   # при > 2^53 − 1: E_OVERFLOW

exchange_difference(leg_a, leg_b, a_exp, b_exp, spot, mode):          # справочно
  return convert_minor(leg_a, a_exp, b_exp, spot.num, spot.den, mode) − leg_b    # > 0: получено меньше, чем по spot

apply_shock(rate, bp):                              # v1.1; rate ориентирован «валюта → валюта решения»
  f = 10000 + bp;  если f ≤ 0: fail(E_SCHEMA)
  n = BigInt(rate.num) · f;  d = BigInt(rate.den) · 10000;  g = gcd(n, d)
  return {num: n / g, den: d / g, date: rate.date}

to_decision(amount_minor, currency, as_of, ctx):    # ctx = {rates, decision_currency, policy, rounding}; policy — 'spot' или запись (ALG-02 передаёт 'spot')
  p = normalize_policy(ctx.policy, as_of)           # идемпотентна: запись возвращается как есть, строка 'spot' становится {kind: 'spot', as_of, …}
  если currency == ctx.decision_currency: return {amount_minor, rate: null}
  r = rate_at(ctx.rates, currency, ctx.decision_currency, as_of, p)
  если r == null: fail(E_NO_RATE, {pair: currency + '/' + ctx.decision_currency})
  s = p.shock[currency];  если s ≠ null: r = apply_shock(r, s)          # v1.1
  v = convert_minor(amount_minor, currency_exponent(currency), currency_exponent(ctx.decision_currency), r.num, r.den, ctx.rounding ?? p.rounding)
  return {amount_minor: v, rate: r}

to_decision_events(events, accounts, rates, decision_currency, policy, as_of, opts = {}):
  p = normalize_policy(policy, as_of);  ctx = {rates, decision_currency, policy: p, rounding: p.rounding}
  acc = индекс accounts;  оба = { t : все ноги transfer_id = t лежат на счетах liquidity == operating } \ opts.external_transfer_ids      # X12: нога перевода вне events (отрезана окном) на неоперационном счёте — перевод не внутренний
  out = []
  для e в events по (date, amount_minor, cash_event_id):
    a = acc[e.account_id];  если a == null: fail(E_SCHEMA);  если e.currency ≠ a.currency: fail(E_CURRENCY_MISMATCH)
    если a.liquidity ≠ operating: continue                                # справочные счета в ряд не входят
    если e.transfer_id ≠ null и e.transfer_id ∈ оба: continue             # обмен/перевод между своими operating: обе ноги вон
    v = to_decision(e.amount_minor, a.currency, as_of, ctx)
    out += [{...e, amount_minor: v.amount_minor, currency: decision_currency,
             orig_amount_minor: e.amount_minor, orig_currency: a.currency, rate_used: v.rate}]     # rate_used = {num, den, date} или null (валюта решения); amount_min_minor / amount_max_minor, если заданы, — тем же курсом, по одному округлению каждый
  return out                                        # порядок и даты событий не меняются

opening_in_decision(accounts, balances, ctx, as_of):     # остаток каждого operating-счёта переводится отдельно
  return Σ по a с liquidity == operating:  to_decision(balances[a] ?? 0, a.currency, as_of, ctx).amount_minor      # нет записи об остатке — 0

liquid_value(account, balance, rates, ctx):         # запас; operating здесь 0 (он уже в ряде)
  если account.kind == crypto и account.liquidity == operating: fail(E_SCHEMA)
  w = account.kind == crypto ? (account.liquidity_bp ?? 0)                      # D-20, C13: крипта — только liquidity_bp, даже на накопительном счёте
    : account.liquidity == savings ? 10000
    : account.liquidity == asset ? (account.liquidity_bp ?? 0) : 0
  если w ∉ 0..10000: fail(E_SCHEMA);  если w == 0: return 0
  dec_exp = currency_exponent(ctx.decision_currency);  p = ctx.policy
  r = rate_at(rates, account.currency, ctx.decision_currency, p.as_of, p);  если r == null: fail(E_NO_RATE)    # отдельного аргумента as_of у функции нет (C-034): ctx.policy здесь — запись normalize_policy, дата — ctx.policy.as_of
  s = p.shock[account.currency];  если s ≠ null: r = apply_shock(r, s)          # сценарий курса действует и на запас, как на остатки и события
  n = BigInt(balance) · r.num · 10^dec_exp · w;   d = BigInt(r.den) · 10^(account.exponent ?? currency_exponent(account.currency)) · 10000     # одно округление
  return round_div(n, d, ctx.rounding ?? p.rounding)

rate_status(rate, as_of, stale_days = 30):  age = as_of − rate.date;  return {age, stale: age > stale_days}    # плашка, не блок
```

Ключевые решения. **`spot` для всех будущих событий**: будущих курсов нет, любой «курс на дату платежа» был бы выдумкой; риск курса отдан сценарию. **Обмен — не расход**: обе ноги исключены, остатки счетов оцениваются по `spot`, иначе разница курсов попала бы в `trough` как фиктивная трата. **Округление на событие**: каждая сумма — отдельный факт; расхождение с «переводом суммы» не превышает `E/2` minor. **Ввод курса**: строка разбирается `parse_minor` с `exponent = 10` и хранится **как введён** (`9250/10000`), без сокращения; сокращают на `gcd` только производные курсы (C-037; без float). **Резерв и аллокация** (X4, C-038): сумма переводится для `planned`-дохода по `rate_at(…, as_of)` (`spot`; «курса на дату поступления» для плана нет), для `posted` — по `rate_at(…, e.date)` в момент записи `allocation.recorded`; дальше резерв **не переоценивается** (заморожен по курсу даты); при сопоставлении план → факт аллокация пересчитывается от фактической суммы по курсу факта; переоценка резерва — v2 (решение арбитра помечено как требующее взгляда владельца: заморозка накапливает разницу между резервом и стоимостью обязательства в валюте платежа). **Налоги и вердикты** — расчёт по введённым правилам и курсам, не консультация.

## Инварианты и свойства

1. `convert_minor(0) = 0`, `convert_minor(−a) = −convert_minor(a)`; монотонность по `a` при `num/den > 0`.
2. `|convert_minor(a+b) − convert_minor(a) − convert_minor(b)| ≤ 1`.
3. Валюта решения = валюта события → сумма не меняется, курс не нужен.
4. `convert_minor(leg_a, …, implied_rate(leg_a, leg_b)) = leg_b` без потерь.
5. `apply_shock(r, 0) = r`; `apply_shock` монотонна по `bp`.
6. Конвертация не меняет число, даты и порядок событий; `Σ` конвертированных ног между своими operating-счетами не попадает в ряд.
7. Результат не зависит от порядка `rates` и `events` (ключ `(date, fx_id)`).
8. `E_NO_RATE` вместо молчаливого нуля: пары без курса ≤ `as_of` нет — ошибка.
9. Результат — safe-integer, иначе `E_OVERFLOW`.

## Сложность

Курс пары вычисляется один раз на валюту (кэш) — `O(R log R)` по записям курсов; конвертация событий `O(E)`; память `O(E)`. BigInt нужен только внутри `convert_minor`/`liquid_value`.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Событие в валюте решения | без курса, сумма как есть | инвариант 3 |
| Нет курса пары (ни прямого, ни обратного) | `fail(E_NO_RATE)` | REQ-077: не ноль |
| Единственный курс датирован после `as_of` | игнорируется → `E_NO_RATE` | курс из «будущего» — не `spot` |
| Курс старше `fx.stale_days` (45 дн. при 30) | расчёт идёт, плашка «курс не обновлялся 45 дн.» (`W_RATE_STALE`) | REQ-079, X11, C-096 |
| Доход в чужой валюте → аллокация резерва | `planned` — `spot` на `as_of`; `posted` — курс даты факта при записи; далее заморожено | X4, C-038 |
| Есть только обратная пара | дробь переворачивается, подпись «обратный» | курс вводят в удобную сторону |
| Нужна триангуляция (USD→RUB через EUR) | `E_NO_RATE` в v1 | накопление ошибки, нет ввода |
| Экспоненты 0 (JPY) и 8 (BTC) | обе экспоненты в формуле | иначе ошибка в 10^k раз |
| Ничья 0,5 minor | `half_even`; знак симметричен | ADR-002 |
| Произведение > 2^53 | BigInt; результат вне safe → `E_OVERFLOW` | ADR-002 |
| Обмен между двумя operating | обе ноги исключены; разница справочно | D-20 |
| Перевод operating → savings в чужой валюте | operating-нога — расход, конвертируется | деньги ушли из ряда |
| `leg_a = 0` или `leg_b = 0` | `fail(E_SCHEMA)` | курс не определён |
| Крипта на operating-счёте | `fail(E_SCHEMA)` | крипта в `operating` не входит |
| `bp ≤ −10000` в сценарии | `fail(E_SCHEMA)` | курс ≤ 0 |

## Тест-векторы

**TV-1. `spot`.** `convert_minor(200000, 2, 2, 9250, 10000)`: `n = 200000·9250·100 = 185 000 000 000`, `d = 10000·100 = 1 000 000` → **185000** (1 850,00 €), остаток 0. Тот же вызов даёт TST-27.

**TV-2. Сценарий −5 %.** `apply_shock({9250, 10000}, −500)`: `n = 9250·9500 = 87 875 000`, `d = 10000·10000 = 100 000 000`, `gcd = 125000` → `703/800`. `convert_minor(200000, 2, 2, 703, 800)` = `200000·703/800` = **175750** (1 757,50 €; −9250 minor = −92,50 €).

**TV-3. Выведенный курс (§9.12 канона).** Продано 200000 ($), получено 184240 (€): `implied_rate` = `184240/200000` → `gcd = 80` → **2303/2500** (0,9212); проверка `200000·2303/2500 = 184240`. `exchange_difference` при `spot` 9250/10000: `185000 − 184240` = **760** (7,60 €). Обе ноги в `to_decision_events` отбрасываются.

**TV-4. Крипта.** `convert_minor(150000, 8, 2, 50000, 1)`: `n = 150000·50000·100 = 750 000 000 000`, `d = 10^8` → **7500** (75,00 €). `liquid_value` при `liquidity_bp = 3000`: `n = 150000·50000·100·3000 = 2,25·10^15`, `d = 10^8·10^4 = 10^12` → **2250**; при значении по умолчанию — 0. 150001 сатоши → `7500,05` → 7500.

**TV-5. G-001 (горизонт 57 дн.).** Все события EUR → `to_decision_events` возвращает вход без изменений, пар курса нет, `opening = 400000`, `end_close = 340000`, `min trough` plan 205500 · 2026-10-31. Вариант «+ счёт USD 200000» (иллюстрация, не канон): `opening = 400000 + 185000 = 585000`; без событий в USD `end_close = 340000 + 185000 = 525000`, `min trough` = `205500 + 185000` = 390500; при −5 %: `400000 + 175750 = 575750`, минимум 381250 (Δ = −9250).

**TV-6. Выбор курса.** `rates`: USD→EUR 9250/10000 (2026-08-20), USD→EUR 9100/10000 (2026-10-01), EUR→USD 10900/10000 (2026-10-03), USD→EUR 9300/10000 (2026-10-10); `as_of = 2026-10-04`. Прямой ≤ `as_of`: 10-01; обратный: 10-03 (позже) → выбран обратный `{num: 10000, den: 10900}`; запись 10-10 игнорируется. `convert_minor(200000, 2, 2, 10000, 10900)` = `2 000 000 000 / 10900 = 183486,24` → **183486**.

**TV-7. Экспоненты, ничьи, BigInt.** 10000 JPY при иллюстративном 62/10000: `n = 10000·62·100`, `d = 10000·10^0` → **6200** (62,00 €). `convert_minor(1, 2, 2, 1, 2)`: `0,5` → `half_even` 0, `half_up` 1; для −1: 0 и −1; `convert_minor(5, …)` = `2,5` → 2 и 3. `a = 2·10^12`, 9250/10000: `a·9250·100 = 1,85·10^18 > 2^53` — результат 1 850 000 000 000 верен лишь через BigInt. `a = 9007199254740991`, курс 2/1 → `E_OVERFLOW`.

## Варианты и альтернативы

Единая базовая валюта, вектор остатков без вердикта, «курс на дату платежа», haircut крипты по умолчанию и автозагрузка курсов отвергнуты в [ADR-012](../decisions/adr-012-fx-rate-policy.md). Как у других (только проверенные факты из `tools/`):

| Продукт | Что есть | Что не найдено |
|---|---|---|
| [PocketSmith](../tools/pocketsmith.md) | валюта счёта + пересчёт в базовую (курс обновляется ежечасно); бюджеты — по текущему курсу | сценарий курса; операция в чужой валюте импортируется суммой счёта без конвертации |
| [Actual Budget](../tools/actual-budget.md) | «currency agnostic»; обход — правила с ручным курсом | мультивалютность |
| [Firefly III](../tools/firefly-iii.md) | обе суммы при разной валюте, курсы вручную или из хранилища проекта (без истории), `pc_*` в primary | прогноз |
| [hledger](../tools/plain-text-accounting.md) | цена операции `@`/`@@`, база цен `P`, оценка `-V/-X` | прогноз с валютой решения |
| [Float](../tools/business-cashflow-tools.md) | мультивалютность официально не подтверждена | — |
| Budget Guru | заявлен «фактический курс каждой операции» (не проверено) ([разбор](../tools/budget-guru.md)) | всё прочее |

### Не в v1

`fx_shock` — v1.1 (pseudo выше реализуется в прототипе). Политика `adverse` — доходы × (1 − h), расходы × (1 + h), `h` из истории курсов (REQ-081: при 500 bp доход 185000 → 175750, расход 100000 → 105000), вектор остатков по валютам, пакеты курсов, переоценка резервов (X4) — v2. Курс «на дату операции» для прошлых фактов — только справочно.

## Реализация в прототипе

**Статус: реализовано** (сверка с кодом 2026-10-04). Модуль `prototype/engine/fx.mjs` (зависит от `money`, `dates`; без `Date`, сети и `Math.random`). Реализованы все функции страницы, включая сценарий курса `fx_shock` (v1.1). Тест-векторы TV-1…TV-7 воспроизводятся движком до minor; TV-5 проверен и на уровне `analyze` (вариант «+ счёт USD 200000»: `opening` 585000, `end_close` 525000, минимум `trough` 390500; со сценарием `fx_shock{USD, −500}` — 575750 и 381250).

```js
convert_minor(a, base_exp, quote_exp, num, den, mode = 'half_even') -> int
implied_rate(leg_a, leg_b, base_exp, quote_exp) -> {num, den}
rate_at(rates, base, quote, d, policy?) -> {num, den, date, inverse} | null    // policy зарезервирован и не читается
apply_shock(rate, bp) -> {num, den, date}                                  // v1.1; несократимая дробь
normalize_policy(policy, as_of?) -> {kind, as_of, shock, rounding}        // as_of — EpochDay; без даты E_BAD_DATE
to_decision(amount_minor, currency, as_of, ctx) -> {amount_minor, rate}    // ctx = {rates, decision_currency, policy, rounding?}
to_decision_events(events, accounts, rates, decision_currency, policy, as_of, opts?) -> CashEvent[]   // policy — 'spot' | запись; opts = { external_transfer_ids?: Set<string> } (X12)
opening_in_decision(accounts, balances, ctx, as_of) -> Minor               // balances — объект или Map
exchange_difference(leg_a, leg_b, a_exp, b_exp, spot, mode = 'half_even') -> Minor
liquid_value(account, balance, rates, ctx) -> Minor                        // ctx.policy — запись, не строка
rate_status(rate, as_of, stale_days = 30) -> {age, stale}                  // stale_days = fx.stale_days (30, гипотеза)
```

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1, и сценарий курса `fx_shock` (v1.1). В `fx.mjs` с 2026-10-05 аддитивные изменения: явный нулевой остаток в чужой валюте курса не требует (`opening_in_decision`, Q-16 — это закрыло `todo` D-20), код валюты в сдвиге курса читается как данные, а не как имя из `Object.prototype` (`Object.hasOwn`, Q-07), порог `fx.stale_days` в `rate_status` берётся из словаря (FP-17). Вокруг ядра: `engine/liquidity.mjs` (FP-08, REQ-018, REQ-080: «запас» отдельно от operating, крипта по `crypto.liquidity_bp`, по умолчанию неликвидна) и `engine/io_fx_rows.mjs` (FP-29, A14.7: строка выписки в чужой валюте с двумя ногами становится обменом между двумя счетами; курс обмена выводится из ног — `implied_rate`, справочная разница к курсу из данных — `exchange_difference`; нет курса пары — отказ строки `no_rate`, а не молчаливый ноль). Демо: форма «Курсы и обмен» (`form_fx.mjs`, FP-08), у каждой пересчитанной суммы подпись «курс … от …» с возрастом в днях и пометкой «курс устарел» при возрасте больше `fx.stale_days` (`rate_chip.mjs`, FP-16), плашка `W_RATE_STALE` с валютой и возрастом, текст отказа `E_NO_RATE` с парой валют и путём «Формы данных → Курсы и обмен» (`banner_texts.mjs`), формат чисел и дат пользователя на всех поверхностях (FP-16), выбор валюты решения в «Настройках» (`decision_currency.mjs`, FP-29, A08.7: отказ при отсутствии курса или резерве в прежней валюте), чипы курса ±N % в конструкторе сценариев. **Не реализовано:** политика `adverse` (A08.8), вектор остатков по валютам, пакеты курсов, переоценка резервов в валюте платежа (X4) — v2; триангуляция обмена через третью валюту (обмен принимается, только если вторая нога в валюте счёта импорта); курсы вводятся вручную, фонового получения курсов нет. Суммы буфера и порога волны при смене валюты решения не пересчитываются — экран говорит об этом.

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; в скобках число тестов файла):

- `prototype/tests/fx.test.mjs` (18 тестов): TST-27 (`convert_minor` TV-1, сценарий TV-2, `implied_rate` TV-3, выбор курса TV-6, `rate_at`, `normalize_policy`, `to_decision`, `to_decision_events`, TV-5 с `opening_in_decision`, `exchange_difference`, `rate_status`), TST-28 (крипта TV-4, `liquid_value`), тест «ALG-08 TV-7» без метки (экспоненты, ничьи, BigInt, `E_OVERFLOW`: по смыслу это TST-16 и TST-18 — сами они живут в тестах `money`), TST-53 (оракул `convert_minor` на BigInt, 20 000 случаев), TST-51 (свойства), TST-33 (часть, детерминизм).
- `prototype/tests/adversarial/golden_properties.test.mjs` — B-70 (независимый BigInt-расчёт), B-73/B-74 (`fx_shock` на остаток и поток), B-79 (`W_RATE_STALE`); `prototype/tests/adversarial/semantics.test.mjs` — раздел FX и `analyze` с несколькими валютами (в названиях часть тестов помечена TST-28 вместо TST-27); `prototype/tests/analyze.test.mjs`.
- `prototype/tests/hardening.test.mjs` (40, один пропущен): закрытие D-20 — явный нулевой остаток в чужой валюте (Q-16, «TST-27 Q-16 …»).
- `prototype/tests/fx_labels.test.mjs` (14), `number_format_surfaces.test.mjs` (12), `fp16_adv.test.mjs` (12), `fp16_fix.test.mjs` (12): подпись курса и возраста у события расчёта, «курс устарел» на границе `fx.stale_days`, сценарий курса и обратная пара, тексты «нет курса» с парой и путём, формат чисел пользователя (FP-16).
- `prototype/tests/io_fx_rows.test.mjs` (14), `decision_currency.test.mjs` (10), `liquidity.test.mjs` (7), `import_v11_boot.test.mjs` (11): обмен двумя ногами с выведенным курсом, выбор валюты решения, запас отдельно от operating, мастер импорта на настоящем `app.mjs` (FP-29, FP-08).
- Мутации ядра: у `fx.mjs` 7 порч, все убиты тестами модуля; замок вывода движка заметил 1, golden и property-тесты — 0 (`../_ops/mutation.json`, раздел `engine`): генератор журналов пишет только прямую котировку USD→EUR.

**Расхождения «псевдокод ≠ код»** (после сверки; п. 1 исправлен в псевдокоде страницы):

1. Исправлено на странице: `liquid_value` считает крипту только по `liquidity_bp` (D-20, C13), даже на счёте `liquidity = savings` (прежний порядок условий дал бы 100 %), и применяет сценарий курса; `to_decision_events` принимает `opts.external_transfer_ids` (X12) и переводит коридор `amount_min_minor`/`amount_max_minor` тем же курсом; `normalize_policy` проверяет режим округления и шок; `rate_at` при равных `(date, fx_id)` различает курсы по `num`, `den`; `opening_in_decision` считает отсутствующий остаток нулём; `to_decision` берёт `ctx.rounding ?? policy.rounding`.
2. Нецелые и не-safe аргументы дают `E_NOT_INTEGER`/`E_OVERFLOW` (от `assert_minor`), курс или экспонента вне допустимого — `E_SCHEMA`; переполнение результата отлавливает `round_div`, отдельной проверки `|r| > 2^53 − 1` в `convert_minor` нет (эффект тот же).
3. Проверку «крипта не на `operating`-счёте» (`E_SCHEMA`) выполняют `liquid_value` и `timeline.opening_state`; `opening_in_decision` и `to_decision_events` её не делают. Предупреждение `W_RATE_STALE` строит `analyze` (`index.mjs`, `rate_warnings`) на основе `rate_status`, а не `fx.mjs`; порог `fx.stale_days` читается из `vocab.json` (FP-17).
4. **Закрыто (FP-02, Q-16), было `todo` D-20:** `operating`-счёт в чужой валюте с явным нулевым остатком курса больше не требует (`opening_in_decision`: нулевой остаток — ноль в любой валюте; тот же контракт у `timeline.opening_state`). Остаток, которого в данных нет вовсе (счёт без якоря и без фактов), по-прежнему требует курс (`E_NO_RATE`) — тест `timeline` закрепляет это как сигнал неполных данных. Тест — `hardening` («TST-27 Q-16 …»).

## Связанные страницы

- [ADR-012 политика курсов](../decisions/adr-012-fx-rate-policy.md), [ADR-002 деньги](../decisions/adr-002-money-minor-units.md), [мультивалютность (понятие)](../concepts/multi-currency-fx.md)
- [ALG-02 проекция](alg-02-timeline-projection.md), [ALG-04 «могу ли я купить»](alg-04-can-i-afford.md), [ALG-09 долги и рассрочки](alg-09-debt-amortization.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [PocketSmith](../tools/pocketsmith.md), [Plain-text accounting](../tools/plain-text-accounting.md)
