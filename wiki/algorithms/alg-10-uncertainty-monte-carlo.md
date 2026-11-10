---
title: "ALG-10: неопределённость — seeded Монте-Карло"
type: algorithm
status: reviewed
summary: "Seeded Монте-Карло (v2, в прототипе есть): возмущения лагов, часов, курса и оценочных трат, счётчиковый хэш и общие случайные числа, P10/P50/P90, p_gap_any, p_fail, честные малые выборки; числа G-001."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/red-team-critique.md, wiki/decisions/adr-008-uncertainty-scenarios-monte-carlo.md, wiki/tools/pocketsmith.md, wiki/tools/business-cashflow-tools.md, wiki/tools/actual-budget.md, wiki/tools/firefly-iii.md, wiki/tools/plain-text-accounting.md, wiki/tools/budget-guru.md]
updated: 2026-10-27
---

# ALG-10 Неопределённость: seeded Монте-Карло

## Назначение

Главный источник кассового разрыва у почасовика — задержка выплаты. Алгоритм превращает «я не знаю, когда придёт оплата» в воспроизводимый диапазон: сколько денег будет по дням (P10/P50/P90), в какой доле прошлых случаев минимум уйдёт ниже нуля (`p_gap_any`) и в какой — ниже буфера после покупки (`p_fail`). Относится к вопросам **Q1** (диапазон остатка) и **Q3** (вероятностный вердикт, допуск риска `α`).

Это **v2**: в v1 неопределённость выражена режимом `worse` и сценариями, вероятностей в интерфейсе нет ([ADR-008](../decisions/adr-008-uncertainty-scenarios-monte-carlo.md), [ADR-015](../decisions/adr-015-v1-slice.md)); прототип реализует модуль целиком. Реализует REQ-054, REQ-055 ([требования](../product/02-requirements.md)); идеи IDEA-24, IDEA-25, IDEA-26, IDEA-46, IDEA-94 ([предложение по движку](../ideas/proposal-engine.md), [критика](../ideas/red-team-critique.md)); определения D-15, D-16 из `_ops/design-brief.md`. Понятие — [неопределённость и сценарии](../concepts/uncertainty-and-scenarios.md). Результат — расчёт по введённым данным и истории пользователя, не прогноз и не совет; при малом числе наблюдений он показывается только как счёт «в k из n».

## Определения

Числа — G-001, **горизонт 57 дн.** (`as_of` 2026-10-04, `N = 58`), `B = 50000`. Обозначения едины с D-15/D-16 (C-061): число путей — `n_paths`, число наблюдений — `n`, число дней сетки — `N` (D-01).

- **Путь** — один набор возмущённых событий; по нему строятся `close`, `trough`, `free` ([ALG-02](alg-02-timeline-projection.md), [ALG-11](alg-11-safe-to-spend.md)).
- **Возмущения (`kinds`)**: `lag` — лаг выплаты дохода, бутстрап наблюдений потока; `hours` — сумма дохода, треугольное распределение по `amount_min/exp/max`; `ratio` — отношение факт/план оценочной траты, бутстрап; `fx` — относительный сдвиг курса в `bp`, бутстрап истории курсов. Расходы-обязательства даты и суммы не меняют.
- **Счётчиковый хэш**: `u = u01(seed, key, path)` — функция трёх аргументов, без состояния. Правка одного события не меняет `u` других (ключ — идентификатор события); сценарии сравниваются на **общих** путях (CRN): разность не содержит шума выборки.
- `seed = H(engine_version, inputs_hash, user_seed)`; `H` — свёртка `mix32` по `engine_version`, 64 hex-знакам `inputs_hash` (без префикса) и `user_seed mod 2^32`; `sha256` и `ledger` в зависимости `montecarlo` не входят (`inputs_hash` и так хэш; C-050).
- `m_p = min_{i ≥ idx(D)} free_p[i]` — минимум свободных денег пути после даты покупки; **квантиль минимумов**, не минимум квантилей.
- `p_fail(S) = #{p : m_p − S < B} / n_paths`; `OK(α) ⇔ q_α(m) − S ≥ B`, где `q_α` — nearest-rank. Эквивалентно `p_fail(S) < α` (доказательство ниже).
- `p_gap_any = #{p : min_i trough_p[i] < 0} / n_paths` — **не** `max_i p_gap[i]`: при двух путях, уходящих в минус на 3-й и 7-й день, дневные вероятности по 50 %, итог — 100 %.
- `P_q = sorted_asc[ceil(q·n/100) − 1]`; низкие значения остатка — «хуже». При `ceil(q·n/100) = n` подпись «наибольшее из n», при `= 1` и `q < 50` — «наименьшее из n».
- `n_obs` — число наблюдений источника; `n_eff` — минимум `n_obs` по источникам, зависящим от данных (`lag`, `ratio`, `fx`); `hours` данных не использует и в `n_eff` не входит (C-048). Для одного источника с `≤ 64` наблюдениями вместо выборки делается полный перебор наблюдений («k из n» без ошибки выборки, `plan_paths`). Ошибка симуляции `√(p(1−p)/n_paths)` — не неопределённость модели: интервал Уилсона считается по `n_eff`, не по `n_paths`.

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `ctx.as_of`, `ctx.horizon_end` | `EpochDay` | сетка `N` дней (`ctx` — `Analysis` из `analyze`, C-012, плюс порты ниже) |
| `ctx.events` | `CashEvent[]` | события шагов 1–5 [ALG-02](alg-02-timeline-projection.md) (до режима; в `Analysis` — `events.plan`), в валюте решения; `plan_date` — плановая дата после правок сценария и до `max(·, as_of)` (C-005), `orig_currency` — из [ALG-08](alg-08-fx-conversion.md) |
| `ctx.evaluate(events)` | функция | порт: `project` → `reserve_series` → `free_series`; возвращает `{close, trough, free}` длины `N` |
| `ctx.lag_obs`, `ctx.ratio_obs_bp` | `{flow_key → int[]}` | выход `lag_observations` ([ALG-13](alg-13-plan-vs-actual-calibration.md)); `flow_key(e) = counterparty_id ?? stream_id ?? rule_id ?? cash_event_id` (C-025) |
| `ctx.fx_obs_bp` | `{currency → int[]}` | приращения курса пары, `bp`, из истории курсов пользователя; это **вход** `ctx` — окно выборки истории курсов в v1.1 не фиксируется (v2, C-050) |
| `ctx.params` | `Params` | `worse.income_delay_days`, `decision_currency` |
| `n_paths` | int | по умолчанию 2000 (минимум для устойчивых квантилей) |
| `perturbations` | `{kinds, from?: EpochDay, enumerate?: bool}` | `from` — дата покупки `D` (по умолчанию `as_of`); `enumerate: false` принудительно включает выборку вместо перебора (проверка ошибки выборки) |
| `seed` | uint32 | `make_seed(...)` |

| Выход `Paths` | Тип |
|---|---|
| `n_paths`, `seed`, `enumerated`, `n_eff`, `prior_used` | int, uint32, bool, int\|null, bool |
| `close_q[i]`, `trough_q[i]` | `{p10, p50, p90}: Minor` для каждого дня |
| `m_free[p]` | `Minor[n_paths]` — `m_p`; `null`, если `D` за горизонтом |
| `m_trough[p]` | `Minor[n_paths]` — `min_i trough_p[i]`, из него считается `p_gap_any` |
| `p_gap_any`, `p_gap_any_pm` | `{k, n}`; `round_div(1000·k, n)` |
| `warnings[]` | `{code, flow_key}`; коды реестра `vocab.json` (C-021): `W_LAG_BEYOND_HISTORY`, `W_NO_HISTORY` |
| `coarse` | bool — выборка из `n_paths < 100`: квантили грубые |

## Алгоритм

Деньги — целые; `float` только в `u01`, `tri_bp`, `wilson` (допускается `+ − × ÷` и `sqrt`, чтобы результат не зависел от движка JS); всё, что попадает в деньги, проходит через `mul_div`/`round_div` ([§4 канона](../../_ops/design-brief.md)).

```pseudo
# ── генератор без состояния; uint32, imul — 32-битное умножение, сложение по модулю 2^32, >> — логический сдвиг ──
mix32(h):                                      # финализатор murmur3; mix32(0) = 0, mix32(1) = 0x514E28B7
  h = h mod 2^32;  h = h XOR (h >> 16);  h = imul(h, 0x85EBCA6B)
  h = h XOR (h >> 13);  h = imul(h, 0xC2B2AE35);  h = h XOR (h >> 16);  return h
fold32(acc, x) = mix32(((acc XOR x) + 0x9E3779B9) mod 2^32)       # симметрична по (acc, x) из-за XOR; порядок важен только в цепочке свёрток (make_seed, u01)
hash_str(s):  h = 0x811C9DC5;  для b в utf8(s): h = imul(h XOR b, 0x01000193);  return mix32(h)

make_seed(engine_version, inputs_hash, user_seed) -> uint32:
  inputs_hash без префикса «sha256:» обязан быть 64 hex-знаками нижнего регистра, иначе fail(E_SCHEMA)
  acc = hash_str(engine_version)
  для i в 0..7: acc = fold32(acc, parse_hex32(inputs_hash[8i..8i+8)))
  return fold32(acc, user_seed mod 2^32)                          # user_seed по умолчанию 0

u01(seed, key, path) -> [0, 1):  return fold32(fold32(seed, hash_str(key)), path) / 2^32     # деление точное

# ── распределения ──
sample_lag(obs, u):  n = len(obs);  return obs[min(n − 1, floor(u·n))]     # obs отсортирован по возрастанию, n ≥ 1
nearest_rank(sorted_asc, q):  return sorted_asc[max(0, ceil_div(q·len(sorted_asc), 100) − 1)]     # q — целые %, 1..100; определена в calibration (ALG-13), здесь реэкспорт
tri_bp(u, c_bp) -> 0..10000:                                       # треугольное на [0,1], мода c_bp/10000
  c = c_bp / 10000;  t = (u < c) ? sqrt(u·c) : 1 − sqrt((1 − u)·(1 − c))
  return min(10000, floor(t·10000 + 0.5))

lag_pool(ctx, e) -> { obs, n_obs, prior }:                         # e — доход expected/overdue
  age = max(0, ctx.as_of − (e.plan_date ?? e.date))                # у просроченного — дней просрочки
  raw = sorted(ctx.lag_obs[flow_key(e)] ?? []);  n_obs = len(raw);  prior = false
  если n_obs == 0: raw = [0, 1, …, ctx.params.worse.income_delay_days];  prior = true;  warn(W_NO_HISTORY)
  cond = [x в raw: x ≥ age]                                        # условный лаг: платёж уже ждём age дней (IDEA-03)
  если cond пуст: warn(W_LAG_BEYOND_HISTORY);  cond = [∞]          # дольше всего виденного — в горизонт не попадает
  return { obs: cond, n_obs, prior }
```

`flow_key(e) = counterparty_id ?? stream_id ?? rule_id ?? cash_event_id` (C-025; определена в [ALG-13](alg-13-plan-vs-actual-calibration.md)). Для `cond = [∞]` дата события заведомо больше `horizon_end`, и доход из пути выпадает.

```pseudo
perturb_events(ctx, kinds, seed, p, enum_lag) -> CashEvent[]:      # копия ctx.events; порядок — (date, amount_minor, cash_event_id)
  out = []
  для e в ctx.events:
    e2 = копия e;  inc = (e.kind == income и e.layer == planned и e.status ∈ {expected, overdue} и e.amount_minor > 0)
    если inc и 'hours' ∈ kinds и e.amount_min_minor < e.amount_max_minor:                 # lo ≤ amount ≤ hi, иначе пропуск
      lo = e.amount_min_minor;  hi = e.amount_max_minor
      c = round_div(10000·(e.amount_minor − lo), hi − lo, half_even)
      e2.amount_minor = lo + mul_div(hi − lo, tri_bp(u01(seed, e.cash_event_id + '|hours', p), c), 10000)
    если e.is_estimate и e.amount_minor < 0 и 'ratio' ∈ kinds и ctx.ratio_obs_bp[flow_key(e)] непуст:
      r = sample_lag(sorted(ctx.ratio_obs_bp[flow_key(e)]), u01(seed, e.cash_event_id + '|ratio', p))
      e2.amount_minor = mul_div(e.amount_minor, max(0, r), 10000)                         # r — факт/план в bp; отрицательное наблюдение (ошибка данных) зажимается в 0, как у fx
    если inc и 'lag' ∈ kinds:
      L = lag_pool(ctx, e);  lag = enum_lag ?? sample_lag(L.obs, u01(seed, e.cash_event_id + '|lag', p))
      e2.date = (e.plan_date ?? e.date) + lag;  если e2.date > ctx.horizon_end: continue   # вне горизонта
    если 'fx' ∈ kinds и e.orig_currency ≠ ctx.params.decision_currency и ctx.fx_obs_bp[e.orig_currency] непуст:
      δ = sample_lag(sorted(ctx.fx_obs_bp[e.orig_currency]), u01(seed, 'fx:' + e.orig_currency, p))   # один сдвиг на путь и валюту
      e2.amount_minor = mul_div(e2.amount_minor, max(0, 10000 + δ), 10000)
    out.push(e2)
  return out

plan_paths(ctx, kinds, n_paths) -> { n, enum_lags }:               # полный перебор вместо выборки
  inc = [e в ctx.events: доход expected/overdue];  L = (len(inc) == 1) ? lag_pool(ctx, inc[0]) : null
  если kinds == ['lag'] и L ≠ null и не L.prior и len(L.obs) ≤ 64 и L.obs[0] ≠ ∞: return { n: len(L.obs), enum_lags: L.obs }
  return { n: n_paths, enum_lags: null }                           # пути = наблюдения: ошибки выборки нет

run_paths(ctx, n_paths, perturbations, seed) -> Paths:
  kinds = perturbations.kinds;  j0 = (perturbations.from ?? ctx.as_of) − ctx.as_of
  { n, enum_lags } = plan_paths(ctx, kinds, n_paths)                # perturbations.enumerate == false → { n_paths, null }: принудительная выборка
  для p в 0..n−1:
    s = ctx.evaluate(perturb_events(ctx, kinds, seed, p, enum_lags ? enum_lags[p] : null))
    CL[p] = s.close;  TR[p] = s.trough;  m_free[p] = min(s.free[j0 .. N−1]);  m_tr[p] = min(s.trough)
  для i в 0..N−1:
    close_q[i]  = { p10: nearest_rank(sorted(CL[·][i]), 10), p50: …, 50, p90: …, 90 };  trough_q[i] = то же по TR
  k = #{p: m_tr[p] < 0}
  return { n_paths: n, seed, enumerated: enum_lags ≠ null, n_eff: min n_obs по источникам lag/ratio/fx (иначе null), prior_used,
           close_q, trough_q, m_free, p_gap_any: {k, n}, p_gap_any_pm: round_div(1000·k, n) }
```

Вероятностный Q3 и подача:

```pseudo
p_fail(m_paths, S, B) -> { k, n }:  return { k: #{p: m_paths[p] − S < B}, n: len(m_paths) }
q_alpha(m_paths, alpha) = nearest_rank(sorted(m_paths), alpha)                 # alpha — целые %, 1..99
ok_at_alpha(m_paths, S, B, alpha) = q_alpha(m_paths, alpha) − S ≥ B
s_max_alpha(m_paths, B, alpha) = max(0, q_alpha(m_paths, alpha) − B)

present_probability(k, paths) -> Presentation:                                 # D-15, REQ-055
  если paths.enumerated: (k_e, n_e) = (k, paths.n_paths)
  иначе: n_e = paths.n_eff ?? 0;  k_e = round_div(k·n_e, paths.n_paths)         # доля путей, пересчитанная на n_eff
  если n_e == 0: return { kind: none, reason: no_history }                     # только prior или диапазон часов
  если n_e < 20: return paths.enumerated ? { kind: count, k: k_e, n: n_e } : { kind: none, reason: small_sample, n: n_e }
  w = wilson(k_e, n_e, 196);  return { kind: interval, p_pm: round_div(1000·k_e, n_e), lo_pm: w.lo_pm, hi_pm: w.hi_pm, n: n_e }
```

Решения. **Счётчиковый хэш** вместо потока: порядок вычислений, число путей и правка соседних событий не меняют `u` события — ключевое для CRN и для `arith.lock`. **Бутстрап** — только значения, которые пользователь действительно видел; хвост за пределами выборки не выдумывается, поэтому `P90` при `n ≤ 9` есть максимум и подписывается «наибольшее из n». **Просрочка дольше истории** трактуется консервативно (дохода в горизонте нет), чтобы не получить ложное спокойствие (IDEA-95). **Эквивалентность `OK(α)` и `p_fail < α`**: индекс `ceil(α·n/100) − 1` меньше `α·n/100`, и пути с провалом — именно `k` наименьших `m_p`; значит `q_α ≥ B + S` ⇔ `k ≤ ceil(α·n/100) − 1` ⇔ `100·k < α·n`. **Подача** (IDEA-26, IDEA-46): ответ плюс одна причина; красный — только детерминированный разрыв `trough < 0` в `worse` ([ALG-02](alg-02-timeline-projection.md), ADR-008; условие `p_fail ≥ 20 %` из IDEA-26 отвергнуто, C-057); веер 80 % = `[P10, P90]`; денежные границы веера при показе в укрупнённых единицах округляются наружу (IDEA-46), а границы Уилсона в ‰ — к ближайшему (числа REQ-055 «5,5–26,1 %» сохранены, C-049); слова-пороги вероятностей — только при `n_eff ≥ 20` (значения порогов — гипотеза, v2).

## Инварианты и свойства

1. **Воспроизводимость**: одинаковые `(ctx, seed, kinds, n_paths)` дают побайтно равный `Paths`; порядок `ctx.events` не влияет.
2. **Локальность (CRN)**: добавление, удаление или правка события `e'` не меняет `u` ни одного другого события; два сценария на одном `seed` сравниваются путь в путь.
3. `P10 ≤ P50 ≤ P90` для каждого дня; `trough_q[i].p_q ≤ close_q[i].p_q`.
4. `0 ≤ p_gap_any_pm ≤ 1000`; `p_gap_any ≥ max_i p_gap[i]`.
5. `p_fail(S)` не убывает по `S`; `s_max_alpha` не убывает по `α`; `OK(α) ⇔ 100·k < α·n`.
6. Если возмущается только `lag`, все лаги источника `≤ worse.income_delay_days`, суммы не меняются, а `Σ rate_bp` правил на одно поступление `≤ 10000` (валидация, C-032), то для каждого пути `trough_p[i] ≥ trough_worse[i]` и `free_p[i] ≥ free_worse[i]`; значит `min m_free ≥ min free_worse`. Версия налогового правила выбирается по `base(e) = max(plan_date, as_of)`, не по возмущённой дате (C-016), поэтому аллокации не зависят от лага и условие безусловно.
7. Покупка `S` с `date ≥ from` снижает каждое `m_p` не более чем на `S`.
8. В режиме `enumerated` результат не зависит от `seed`.
9. Детерминизм не зависит от платформы: используются только `imul`, сдвиги, `+ − × ÷`, `sqrt`.

## Сложность

Время `O(n_paths · (E + N))` на пути и `O(N · n_paths · log n_paths)` на квантили; `n_paths = 2000`, `E ≈ 10³`, `N = 181` — порядка 10⁶–10⁷ операций (вывод). Замер прототипа (Node 24, `evaluate` = `project` → `reserve_series` → `free_series`): 2000 путей на G-001 (`N = 58`, `E = 16`) — 0,4–0,7 с; тест TST-48 допускает до 5 с. На наборе TST-54 (`E = 1084`, `N = 181`, возмущается только `lag` по prior) 1000 путей заняли 0,95 с — около 0,95 мс на путь, то есть 2000 путей ≈ 1,9 с; первоначальная оценка «десятки миллисекунд» не подтвердилась: цена пути — полный пересчёт ряда ([стратегия тестирования](../product/11-testing-strategy.md), TST-54). Замеры разовые, на одной машине, без p95. Память `O(n_paths · N)` на матрицы `close` и `trough`; узкое место — сортировка столбцов, её можно заменить выбором k-й порядковой статистики.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Нет наблюдений (`n_obs = 0`) | prior `[0 … worse.income_delay_days]`, `prior_used`, `W_NO_HISTORY`; вероятность не показывается | данных нет, диапазон — оценка |
| `n_obs = 1` | все пути одинаковы, `n_eff = 1`; вероятность не показывается | нет разброса |
| Просрочка дольше любого лага | `cond = [∞]`, доход вне горизонта, `W_LAG_BEYOND_HISTORY` | не придумываем лучшего исхода, чем виденный |
| Доход после `horizon_end` | событие из пути исключено | D-04 |
| `amount_min = amount_max` | `hours` не возмущается | нет разброса |
| Событие вне `[lo, hi]` у `hours` | событие не возмущается, предупреждения нет | мода вне носителя |
| Два дохода в горизонте | выборка (`enumerated = false`), независимые лаги по ключам | перебор был бы произведением |
| `user_seed` вне `uint32` | берётся по модулю `2^32` | детерминизм |
| `inputs_hash` не 64 hex | `fail(E_SCHEMA)` | seed не воспроизводим |
| `D > horizon_end` | `m_free = null`; «в горизонте нет» | как в [ALG-04](alg-04-can-i-afford.md) |
| `n_paths < 100` (выборка) | флаг `coarse = true`, квантили грубые; кода предупреждения нет | ошибка симуляции |
| Много валют, нет истории курса | `fx` не возмущается | нечего бутстрапить |

## Тест-векторы

**TV-1. Генератор (TST-48).** `mix32(0) = 0`, `mix32(1) = 0x514E28B7`, `mix32(0xFFFFFFFF) = 0x81F16F39`. Синтетический `inputs_hash = '0123456789abcdef'×4`: `make_seed('0.1.0', h, 0) = 68106871`, с `user_seed = 1` — `477279656`; `hash_str('S-HOURLY@2026-11-05|lag') = 1311552458` (ключ — `occ_key` из [ALG-07](alg-07-hourly-income.md) плюс `|lag`). При `seed = 68106871` `u01` для путей 0…3: `0.27058609, 0.29148285, 0.66307358, 0.08763797`; по 8 наблюдениям `[0, 2, 3, 5, 6, 7, 9, 14]` индексы `floor(8u) = 2, 2, 5, 0` → лаги `3, 3, 7, 0`. При `seed = 477279656` путь 0: `u = 0.91283491`, индекс 7 → лаг 14.

**TV-2. G-001: восемь лагов `[0, 3, 7, 5, 14, 6, 2, 9]` (REQ-054), `kinds = [lag]`, перебор наблюдений (`enumerated = true`).** Доход 2026-11-05 сдвигается на лаг; минимум `free` и минимум после покупки 300,00 € (`S = 30000`, `D = 2026-10-12`, `B = 50000`):

| Лаг, дн | 0 | 2 | 3 | 5 | 6 | 7 | 9 | 14 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `m_p` | 93500<!--num:G-001.free.min.plan=93500--> | 83500 | 83500 | 81000 | 81000 | 81000 | 71000 | 71000<!--num:G-001.free.min.worse=71000--> |
| `m_p − S` | 63500<!--num:G-001.q3.treadmill.m_after.plan=63500--> | 53500 | 53500 | 51000 | 51000 | 51000 | 41000 | 41000<!--num:G-001.q3.treadmill.m_after.worse=41000--> |

Нарушают буфер `m_p − 30000 < 50000` лаги 9 и 14: `p_fail = 2 из 8`. Отсортировано `[71000, 71000, 81000, 81000, 81000, 83500, 83500, 93500]`: `P10 = 71000` (индекс `ceil_div(10·8, 100) − 1 = 0`), `P50 = 81000` (индекс 3), `P90 = 93500` (индекс `ceil_div(720, 100) − 1 = 7`, «наибольшее из 8»). `s_max_alpha`: `α = 10` и `25` → `71000 − 50000 = 21000` (равно `S_max_worse`: наибольший лаг 14 = `worse.income_delay_days`); `α = 26` → индекс `ceil_div(208, 100) − 1 = 2`, `81000 − 50000 = 31000`; `α = 90` → `43500` (= `S_max_plan`). Проверка эквивалентности для `S = 30000`: `p_fail = 25 %`; `OK(25)` — нет (`71000 − 30000 = 41000 < 50000`, `100·2 < 25·8` ложно), `OK(26)` — да (`51000 ≥ 50000`, `200 < 208`). Подача пользователю: «в 2 из 8 прошлых случаев»; интервал 7,1–59,1 % не показывается (`n < 20`).

**TV-3. Веер по дням, те же 8 лагов, `close`/`trough` (TST-49).**

| Дата | `close` P10 / P50 / P90 | `trough` P10 / P50 / P90 | Подписи |
|---|---|---|---|
| 2026-11-05 | 205500 / 205500 / 484500 | 205500 / 205500 / 205500 | P90 — наибольшее из 8 (лаг 0) |
| 2026-11-14 | 183000 / 462000 / 462000 | 183000 / 462000 / 462000 | P10 — наименьшее из 8 (лаг 14) |
| 2026-11-19 | 462000 / 462000 / 462000 | 183000 / 462000 / 462000 | в день прихода `trough` до дохода (D-01) |

**TV-4. `p_gap_any`.** G-001: минимумы `trough` по лагам 205500 (лаг 0), 195500 (2, 3), 193000 (5–7), 183000 (9, 14) — `0 из 8`. G-001-low (`opening = 220000`): 25500, 15500, 13000, 3000 — `0 из 8`, но свободные деньги отрицательны, `p_fail` для любой `S > 0` — `8 из 8`. G-001-gap (`opening = 100000`): минимум `trough` отрицателен при каждом лаге (от −94500 до −117000), первая дата разрыва 2026-10-26 при любом лаге — `8 из 8`, то есть детерминированный разрыв; красный цвет допустим.

**TV-5. Подача (REQ-055, расчёт Уилсона — [ALG-13](alg-13-plan-vs-actual-calibration.md)).**

| `k`, `n` (режим) | Результат |
|---|---|
| 2, 8 (перебор) | «в 2 из 8 прошлых случаев» |
| 1, 8 (перебор) | «в 1 из 8»; интервал 2,2–47,1 % скрыт |
| 5, 40 (`n_eff = 40`) | `p_pm = 125` → «≈ 12,5 % (95 %: 5,5–26,1 %)» |
| 3, 24 | «≈ 12,5 % (95 %: 4,3–31,0 %)» |
| 0, 20 | «≈ 0 % (95 %: 0–16,1 %)» |
| `k = 500` из 2000 путей, `n_eff = 12` (выборка) | `none/small_sample`: процент не показывается |

**TV-6. Выборка (`n_paths = 2000`, `kinds = ['lag']`, `enumerated = false` принудительно).** `seed = 68106871`: `p_fail(30000) = 498 из 2000` (24,9 %; точное значение 25 %; σ = √(0,25·0,75/2000) ≈ 0,97 п.п.); `seed = 477279656`: 493 из 2000; `P10 = 71000`, `P50 = 81000`, `P90 = 93500` в обоих случаях.

## Варианты и альтернативы

Параметрические лаги (логнормальные) требуют `exp`/`log`, зависящих от движка JS, и плохо описывают тяжёлые хвосты; аналитические формулы — то же ([ADR-008](../decisions/adr-008-uncertainty-scenarios-monte-carlo.md)). Поток ГПСЧ с общим состоянием ломает CRN при правке данных. Скалярный «индекс доверия» без формулы — нечего проверять.

| Продукт | Что есть | Что не найдено |
|---|---|---|
| Budget Guru | диапазоны и вероятности в источниках не описаны (не подтверждено) ([разбор](../tools/budget-guru.md)) | не проверено |
| [PocketSmith](../tools/pocketsmith.md) | сценарии-дельты поверх базовой линии, переключаются на графике | интервалов и вероятностей |
| [Float](../tools/business-cashflow-tools.md) | до 8 сценариев; Forecast Confidence — оценка по 3 месяцам факта против 6 месяцев прогноза | границы полос не опубликованы |
| [Actual Budget](../tools/actual-budget.md) | отдельный Monte Carlo (с 26.9.0) — про пенсионные накопления | вариативность дат платежей |
| [Firefly III](../tools/firefly-iii.md) | у подписок мин./макс. сумма | прогноз в ядре не поддерживается, интервалов нет |
| [hledger](../tools/plain-text-accounting.md) | `--forecast` по периодическим правилам | неопределённость (вывод) |

### Не в v1

В v1 вероятностей и процентов риска нет: режим `worse` и сценарии «клиент заплатит на N дней позже» ([ALG-02](alg-02-timeline-projection.md)); `p_fail`, `α`, P10/P50/P90 включаются в v2 по согласию пользователя, после появления наблюдений ([ADR-015](../decisions/adr-015-v1-slice.md)). Сценарий курса `fx_shock` — v1.1; режим `expected` — [ALG-13](alg-13-plan-vs-actual-calibration.md).

## Реализация в прототипе

**Статус: реализовано** (страница целиком; в продукте v1 модуля нет — v2, [ADR-015](../decisions/adr-015-v1-slice.md)). Сверено с кодом и тестами 2026-10-04: числа тест-векторов TV-1…TV-6 пересчитаны вызовом функций — все сошлись; обновлено 2026-10-27: сквозной прогон по одному файлу 2026-10-28 — 194 файла, 3452 теста, из них файлы этой темы зелёные ([руководство по прототипу](../product/15-prototype-guide.md)).

Модуль `prototype/engine/montecarlo.mjs`; импортирует только `money`, `dates`, `timeline`, `sinking`, `tax`, `calibration` (`ledger`, `sha256`, `index` и `afford` не нужны, C-050). Из `index.mjs` не реэкспортируется — импорт прямой: `engine/montecarlo.mjs`. Расширенные экспорты (C-056) приняты в канон.

```js
mix32(h) -> uint32 ; fold32(acc, x) -> uint32 ; hash_str(s) -> uint32               // hash_str: FNV-1a по UTF-8, затем mix32
make_seed(engine_version, inputs_hash, user_seed = 0) -> uint32                      // inputs_hash: 64 hex нижнего регистра, префикс «sha256:» допустим; иначе E_SCHEMA
u01(seed, key, path) -> float[0,1) ; sample_lag(obs, u) -> int ; tri_bp(u, c_bp) -> int
nearest_rank(sorted_asc, q) -> int                                                  // реэкспорт из calibration.mjs
lag_pool(ctx, e) -> { obs, n_obs, prior, warnings[{code, flow_key}] }
perturb_events(ctx, kinds, seed, p, enum_lag = null) -> CashEvent[]                 // порядок результата (date, amount_minor, cash_event_id)
plan_paths(ctx, kinds, n_paths) -> { n, enum_lags }
make_evaluate(ws, analysis) -> (events) -> { close, trough, free }                  // порт ctx.evaluate: project → налоги на лету → reserve_series → free_series
mc_context(ws, analysis, { lag_obs, ratio_obs_bp, fx_obs_bp }) -> ctx               // Analysis + events.plan + evaluate + наблюдения
run_paths(ctx, n_paths, { kinds, from?, enumerate? }, seed) -> Paths
p_fail(m_paths, S, B) -> { k, n } ; q_alpha(m_paths, alpha) -> Minor ; ok_at_alpha(m_paths, S, B, alpha) -> bool ; s_max_alpha(m_paths, B, alpha) -> Minor
present_probability(k, paths) -> { kind: 'none', reason: 'no_history'|'small_sample', n? } | { kind: 'count', k, n } | { kind: 'interval', p_pm, lo_pm, hi_pm, n }
```

`Paths` = `{n_paths, seed, enumerated, n_eff, prior_used, close_q[], trough_q[], m_free[]|null, m_trough[], p_gap_any{k,n}, p_gap_any_pm, warnings[], coarse}`. Наблюдения принимаются в двух видах: массив чисел либо объект выхода `lag_observations` (`{lags}`, `{ratios_bp}`) и `{bp}` для курсов.

**Тесты** ([стратегия тестирования](../product/11-testing-strategy.md)):

| Файл | Что покрывает |
|---|---|
| `tests/montecarlo.test.mjs` (38) | TST-48 ×21 — генератор (TV-1), воспроизводимость, локальность и общие случайные числа, источники возмущений (`lag`, `hours`, `ratio`, `fx`), граничные случаи; TST-49 ×12 — восемь лагов, TV-2…TV-6; TST-50 ×4 — калибровка малых выборок (ALG-13); TST-33 — seed из `inputs_hash`; TST-54 (часть) — 2000 путей меньше 5 с |
| `tests/adversarial/verifier_io.test.mjs`, раздел «МОНТЕ-КАРЛО» (14) | TST-33/48/49 — оракулы: лавинность и равномерность `u01` (χ²), `OK(α) ⇔ 100·k < α·n` на 5000 случайных массивах, условный лаг, порядок `perturb_events` |
| `tests/purity.test.mjs`, `tests/backtest.test.mjs` | TST-60 — чистота `montecarlo.mjs` (нет `Date`, `Math.random`, `node:*`, `Intl`), правило слоёв §14 B4 |
| `tests/mc_inputs.test.mjs` (11), `tests/band_adapter.test.mjs` (11), `tests/expected.test.mjs` (6) | входы вероятностных расчётов из истории (приращения курса, лаги, отношения, привычки платежей n ≥ 10), коридор и «при уверенности α» (покупка 30000 при буфере 50000 и лагах `[0, 3, 7, 5, 14, 6, 2, 9]` нарушает буфер в 2 из 8; Уилсон 5 из 40 — 5,5–26,1 %), ряд «ожидаемый» (FP-11, TST-48…50) |
| `tests/prob_band.test.mjs` (20), `tests/quality_report.test.mjs` (17), `tests/reconcile_boot.test.mjs` (4), `tests/fp11_adv.test.mjs` (11, один `todo`) | согласие и экран «Качество прогноза» на заглушке DOM (настоящий `app.mjs`), полоса P10–P90, «при уверенности α»; `todo` ADV-6 — метрики backtest на анонимизированном журнале могут отличаться от исходных ([ALG-13](alg-13-plan-vs-actual-calibration.md)) |

**Псевдокод ≠ код** (результат сверки; «стр.» — исправлена страница, «код» — код оставлен как есть):

| № | Страница (до сверки) | Код | Решение |
|---|---|---|---|
| 1 | «`fold32` — порядок аргументов важен» | `fold32(a, b) = fold32(b, a)` (XOR симметричен); порядок важен лишь в цепочке `u01`, `make_seed` | стр.: подпись у `fold32` уточнена |
| 2 | `hours`, носитель не содержит моду: «событие пропущено, предупреждение» | событие не возмущается, кода предупреждения нет | стр. |
| 3 | `n_paths < 100`: «предупреждение» | флаг `coarse = true` (только выборка), кода предупреждения нет | стр.: добавлен выход `coarse` |
| 4 | `ratio`: `mul_div(amount, r, 10000)` | `r` зажимается `max(0, r)`: отрицательное наблюдение (ошибка данных) переворачивало бы расход в доход; так же у `fx` | стр. |
| 5 | `inc`: доход `planned`, `expected`/`overdue` | дополнительно `amount_minor > 0` | стр. |
| 6 | выходов `m_trough`, `coarse`; входа `enumerate` нет; `warnings` — коды | есть; `warnings = [{code, flow_key}]` | стр. |
| 7 | сложность: «десятки миллисекунд (до замера)» | замер: 2000 путей на G-001 — 0,4–0,7 с; на наборе TST-54 (`E = 1084`, `N = 181`) ≈ 1,9 с | стр.: оценка заменена замером |
| 8 | функции построения `ctx.evaluate` нет | `make_evaluate`, `mc_context`: налоговые аллокации считаются на лету по `max(plan_date, as_of)` (C-016), записанные и плановые взносы резервов учитываются | дополнение кода, в псевдокод не вносилось |

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Модуль `montecarlo.mjs` с 2026-10-05 получил одно изменение: сдвиг дохода `income_delay_days` проверяется по диапазону 0…365 (`E_SCHEMA income_delay_days_out_of_range`; К-4, Q-12 — без диапазона значение задавало длину массива); остальное совпадает со снимком. Три пункта прежнего «Не сделано» закрыты волной 2 (FP-11, 2026-10-09): **(1)** `fx_obs_bp` строит `engine/mc_inputs.mjs` — `fx_obs_from_rates` (приращения курса в bp из `ws.rates`), там же `plan_occurrences`, `plan_window_start`, `match_history`, `mc_observations` (`lag_obs`, `ratio_obs_bp`, `fx_obs_bp`) и `payment_habits` (потоки с n ≥ 10); **(2)** коридор для backtest подключён без нарушения слоёв: `engine/band_adapter.mjs` — `mc_band` (коридор P10 / P50 / P90), `mc_buy` («при уверенности α максимум X» над `s_max_alpha`, `p_fail`, `present_probability`), `quantile_label` (подпись «наименьшее из n» / «наибольшее из n» для малых выборок), `mc_band_adapter` (адаптер коридора, срез журнала передаёт вызывающий); **(3)** в демо вероятности есть, но **только по явному согласию** и выключены по умолчанию: на экране «Качество прогноза» флажок «понимаю: это эксперимент, не обещание» (ключ `runway-prob-consent/1`, его стирает «Удалить все данные»), затем по кнопке «Рассчитать коридор» — график P10–P90 с таблицей-двойником и число наблюдений n, число путей, seed (`prob_band.mjs`), и форма «при уверенности α максимум X» (`prob_buy.mjs`); при n < 20 вероятность подаётся счётом «в k из n» (при полном переборе наблюдений) или «мало наблюдений», процент — только при n ≥ 20 с интервалом Уилсона (D-15); ответ «Могу ли я купить» остаётся детерминированным и от этой оценки не зависит. Ряд «ожидаемый» (`engine/expected.mjs`) — отображаемая оценка, а не режим расчёта. CLI вероятностей не показывает. **Не реализовано:** вероятностный Q3 как часть основного ответа (v2, ADR-015), режим `expected` в `analyze`; настоящих наблюдений на G-001 мало (два платежа), для примера есть источник «Синтетический пример» (15 месяцев, генератор, в данные пользователя не загружается). Расхождений, где виноват код, не найдено.

## Связанные страницы

- [ADR-008 неопределённость](../decisions/adr-008-uncertainty-scenarios-monte-carlo.md), [Неопределённость и сценарии](../concepts/uncertainty-and-scenarios.md)
- [ALG-13 калибровка и backtest](alg-13-plan-vs-actual-calibration.md), [ALG-02 проекция](alg-02-timeline-projection.md), [ALG-04 «могу ли я купить»](alg-04-can-i-afford.md), [ALG-11 safe-to-spend](alg-11-safe-to-spend.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [PocketSmith](../tools/pocketsmith.md), [бизнес-планировщики](../tools/business-cashflow-tools.md)
