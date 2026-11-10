---
title: "ALG-13: сопоставление план↔факт, калибровка, backtest"
type: algorithm
status: reviewed
summary: "Сопоставление факта с планом (один кандидат или очередь), статусы и свежесть данных — v1; калибровка лагов (nearest-rank, EWMA, prior), интервал Уилсона и backtest «как знали тогда» — v2."
sources: [wiki/ideas/proposal-engine.md, wiki/ideas/proposal-product.md, wiki/ideas/red-team-critique.md, wiki/decisions/adr-004-event-journal-projections.md, wiki/decisions/adr-006-forecast-semantics.md, wiki/decisions/adr-008-uncertainty-scenarios-monte-carlo.md, wiki/tools/pocketsmith.md, wiki/tools/actual-budget.md, wiki/tools/firefly-iii.md, wiki/tools/business-cashflow-tools.md, wiki/tools/plain-text-accounting.md, wiki/tools/budget-guru.md]
updated: 2026-10-27
---

# ALG-13 Сопоставление план↔факт, калибровка, backtest

## Назначение

Прогноз живёт, пока факт и план не расходятся. Страница описывает три слоя двух модулей: слои 1–2 — `calibration.mjs`, слой 3 (backtest, гейт релиза) — `backtest.mjs` (design-brief §14 B4: `backtest`, `release_gate`, `default_breach` вынесены из `calibration`, чтобы не было цикла с `timeline`):

1. **v1 — сопоставление и жизненный цикл.** Факт (`posted`) привязывается к плану (`planned`), чтобы не считать платёж дважды; вхождение получает статус `expected / matched / overdue`; свежесть остатка и дрейф (D-22) определяют, показывать ли вердикт Q3. Относится к **Q1**.
2. **v2 — калибровка.** Из сопоставленных пар извлекаются наблюдения: лаг (`F.date − P.date`) и отклонение суммы; по ним — квантили nearest-rank, EWMA и сжатие к prior. Они питают режим `expected` ([ADR-006](../decisions/adr-006-forecast-semantics.md)) и бутстрап [ALG-10](alg-10-uncertainty-monte-carlo.md).
3. **v2 (в прототипе есть) — backtest «что бы мы предсказали тогда»** и метрики: MAE, bias, skill, покрытие интервала, доля ложного спокойствия (FRR) и ложных тревог (cry-wolf); гейт релиза v1.

Реализует REQ-027, REQ-028, REQ-031, REQ-032, REQ-053, REQ-055, REQ-176 ([требования](../product/02-requirements.md)); идеи IDEA-02, IDEA-03, IDEA-27, IDEA-28, IDEA-38, IDEA-91, IDEA-95 ([предложение по движку](../ideas/proposal-engine.md), [критика](../ideas/red-team-critique.md)); [ADR-004](../decisions/adr-004-event-journal-projections.md), [ADR-008](../decisions/adr-008-uncertainty-scenarios-monte-carlo.md); определения D-06, D-22. Определение исхода «пробой буфера» и окна `H` фиксирует REQ-176 (замечание X9 канона); до первого замера действует рабочее определение C-055 (см. «Определения»): значения — гипотезы. Все выводы — расчёт по введённым данным, не консультация.

## Определения

Числа — G-001, **горизонт 57 дн.** (`as_of` 2026-10-04), `B = 50000`.

- `win = match.window_days` (3), `tol = match.tol_bp` (500), `grace_days.income/expense` (3/0) — гипотезы до проверки на журналах (§12 канона).
- **Расхождение** `d = ||F| − |P||`. Классы: `in_tol` — `d·10000 ≤ tol·|P|` либо `|F|` внутри коридора плана `[amount_min, amount_max]`; `near` — `d·10000 ≤ 2·tol·|P|`; иначе `far`. Сравнения целочисленные, без деления.
- **Кандидаты** факта `F`: планы того же счёта, знака и валюты в окне `−win ≤ F.date − P.date ≤ win` с классом `≤ near`.
- **Автосопоставление** — только если у `F` ровно один кандидат `P`, у `P` ровно один кандидат-факт и класс `in_tol`. Иначе очередь подтверждения («возможный двойник»): `P` и `F` учитываются оба до решения пользователя (D-06).
- `flow_key(e) = counterparty_id ?? stream_id ?? rule_id ?? cash_event_id` (у событий потока часов `stream_id` задан, `rule_id = null`, C-025; [ALG-07](alg-07-hourly-income.md)).
- **Наблюдение**: `lag = F.date − P.date`, `ratio_bp = round_div(10000·|ΣF|, |P|)`; окно — последние `calib.window = 24` по `flow_key`.
- `p50/p80/p90` — nearest-rank: `sorted_asc[ceil(q·n/100) − 1]`; «медиана» в `shrink_to_prior` — `p50`.
- **EWMA** с `alpha_bp = 3000`: `s_k = α·x_k + (1−α)·s_{k−1}`, `s_0 = x_0`, в целых миллионных долях.
- **Сжатие**: `shrink(median, n, prior, k) = round_div(n·median + k·prior, n + k)`; `prior = 7`, `k = 3` — гипотезы красной команды, не измеренные значения. «Медиана» здесь везде nearest-rank `p50` (C-052). `shrink_to_prior` — подсказка интерфейса: единственное, что сдвигает дату в режиме `expected`, — `lag_p50` при `n_obs ≥ 10` (C-053).
- **Свежесть** (D-22, C-010): `age = as_of − min(дата последнего якоря)` по **operating-счетам** — самый несвежий счёт определяет плашку; у счёта без якоря возраст неизвестен → уровень `block`, причина `no_anchor`; `drift` суммируется по счетам, `stale_accounts[]` — для плашки; `drift = anchor − Σ posted(≤ anchor.date)`; `unlogged_rate = median(|drift_i| / days_i)`.
- **Метрики**: `MAE = mean |F_t(t+h) − A(t+h)|`; `skill = 1 − MAE/MAE_naive` (naive: баланс не меняется); `FRR = #{OK и пробой} / #{OK}`; `cry_wolf = #{FRAGILE|NO без пробоя} / #{FRAGILE|NO}`.
- **Исход «пробой буфера» и пробы (C-055, рабочее определение до первого замера; значения — гипотезы).** Для покупки `e` на момент `t`: пробой — `min` фактического `free` на `[e.date, e.date + H] < B(t)`, где `H = backtest.h_days = 30`; `actual_free(d)` — по полному журналу: фактический `trough` дня (расходы раньше доходов) минус `reserve_trough`. Пробы — реальные расходы без `is_obligation` и `is_estimate` с `|amount| ≥ θ` (`θ = wave.threshold_minor`). Гейт REQ-176 — по **сумме счётчиков** по журналам (≥ 10 журналов, `N1 > 0`, `N2 > 0`, FRR ≤ 5 %, cry-wolf ≤ 50 %). Ошибка минимума (REQ-185): режим `plan`, физический `trough`, окно `backtest.min_window_days = 14`, `(факт − прогноз)/|прогноз|` в bp.

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `plans` | `CashEvent[]` | `layer = planned`: `occ_key`, `account_id`, `currency`, `date` (плановая, после сдвигов), `amount_minor`, `amount_min/max_minor?`, `status` |
| `facts` | `CashEvent[]` | `posted`; опционально `plan_ref: occ_key` (связь, подтверждённая пользователем) и `no_plan: bool` — их проставляет свёртка `reduce` из записей журнала `match.set {fact_event_id, plan_ref?, no_plan?}`; сам факт не мутирует (C-051) |
| `params` | `Params` | `match.*`, `grace_days.*`, `stale.*` |
| `matches` | `Match[]` | `{plan, facts[], by: auto\|user, excluded?}` |
| `journal`, `t0`, `h`, `opts` | | журнал, первая дата-источник, шаг сравнения; `opts = {H, band?, breach?, min_origins = 3, min_window_days = 14}`; `band` — функция `(analysis, t, h) → {lo, hi}`, по умолчанию коридор `[min(plan, worse), max(plan, worse)]` |

| Выход | Тип |
|---|---|
| `match_plan_to_fact` | `{matches[], doubles[{fact, candidates[], reason}], partials[{plan, facts[], residual}], unmatched_plans[], unmatched_facts[]}` |
| `classify_occurrence` | `expected \| matched \| overdue \| skipped \| cancelled` |
| `flow_calibration` | `{n, p50, p80, p90, p90_label, ewma_days, shrunk_days, ratio_ewma_bp, expected_ready}` |
| `backtest` | `{n_origins, hidden, mae_minor, bias_minor, skill_pm, coverage{k,n}, frr{k,n,bp}, cry_wolf{k,n,bp}, insufficient, min_error{n,mean_bp,mae_bp}, n_tight, censored, skipped_origins}` |
| `release_gate` | `{pass, n_journals, k1, n1, k2, n2, frr_bp, cry_wolf_bp, reasons[]}`; `reasons ⊂ {journals_lt_10, no_ok_verdicts, no_alarms, frr_above_5pct, cry_wolf_above_50pct}` |

## Алгоритм

```pseudo
# ── v1: сопоставление ──
dev_class(x, p, tol):                              # x — сумма факта (или Σ частей); знак, валюта, счёт проверены выше
  a = |x|;  b = |p.amount_minor|;  d = |a − b|
  если p.amount_min_minor ≠ null и p.amount_max_minor ≠ null:
     lo = min(|p.amount_min_minor|, |p.amount_max_minor|);  hi = max(...);  если lo ≤ a ≤ hi: return in_tol
  если d·10000 ≤ tol·b:   return in_tol            # BigInt-сравнение; ровно на границе — совпадение
  если d·10000 ≤ 2·tol·b: return near
  return far

match_plan_to_fact(plans, facts, params):
  win = params.match.window_days;  tol = params.match.tol_bp
  P = [p в plans: p.status ∈ {expected, overdue}]                       # matched/skipped/cancelled не участвуют: идемпотентность
  F = [f в facts: f.layer == posted и f.no_plan ≠ true]
  # 0. связи, подтверждённые пользователем (в том числе частичные платежи); факт со связью на план вне P (терминальный или исчез)
  #    в автосопоставлении не участвует и попадает в unmatched_facts
  для p в P: L = [f в F: f.plan_ref == p.occ_key];  если L пуст: continue
     s = Σ f.amount_minor по L
     если dev_class(s, p, tol) == in_tol или |s| > |p.amount_minor|: matches += {plan: p, facts: L, by: user}
     иначе: partials += {plan: p, facts: L, residual: p.amount_minor − s}          # P остаётся expected на остаток
     из F убрать L; для matches убрать и p из P, для partials заменить p копией с amount_minor = residual (остаток ещё может сопоставиться)
  # 1. кандидаты в обе стороны
  для f в F: C[f] = [p в P: p.account_id == f.account_id, p.currency == f.currency, sign(p) == sign(f),
                     −win ≤ f.date − p.date ≤ win, dev_class(f.amount_minor, p, tol) ≠ far]      # сортировка (date, occ_key)
  для p в P: Cinv[p] = [f в F: p ∈ C[f]]
  # 2. решение; результат не зависит от порядка обхода
  для f в F по (date, amount_minor, cash_event_id):
     если C[f] пуст: unmatched_facts += f
     иначе если |C[f]| == 1:
        p = C[f][0]
        если |Cinv[p]| == 1 и dev_class(f.amount_minor, p, tol) == in_tol: matches += {plan: p, facts: [f], by: auto}
        иначе: doubles += {fact: f, candidates: [p], reason: |Cinv[p]| > 1 ? contested : near_tolerance}
     иначе: doubles += {fact: f, candidates: C[f], reason: ambiguous}
  unmatched_plans = [p в P: нет в matches, partials, doubles.candidates]
  return { matches, doubles, partials, unmatched_plans, unmatched_facts }

classify_occurrence(p, as_of, params):
  если p.status ∈ {matched, skipped, cancelled}: return p.status        # терминальные задают сопоставление и пользователь
  g = p.amount_minor > 0 ? params.grace_days.income : params.grace_days.expense
  return (p.date + g < as_of) ? overdue : expected                      # статус выводится заново при каждом as_of

assign_statuses(planned, facts, as_of, params):                         # вызывается из build_events (ALG-02)
  M = match_plan_to_fact(planned, facts, params)
  для p в planned: p.status = p ∈ M.matches ? matched : classify_occurrence(p, as_of, params)
  для r в M.partials: r.plan.amount_minor = r.residual                  # остаток плана, статус expected/overdue
  return planned

# ── v1: свежесть и дрейф ──
unlogged_rate(drifts) -> Minor | null:                                  # drifts = [{drift_minor, days}], days ≥ 1; days = 0 пропускается
  r = sorted([round_div(|d.drift_minor|, d.days, half_even) для d в drifts, d.days ≥ 1]);  n = len(r)
  если n == 0: return null
  return n нечётно ? r[(n−1)/2] : round_div(r[n/2 − 1] + r[n/2], 2, half_even)
stale_status(age, rate, params):                                        # age = anchor_age из opening_state: по самому несвежему operating-счёту (C-010)
  если age == null: return {level: block, reason: no_anchor}            # якоря нет у какого-либо operating-счёта — вердикт Q3 и «можно потратить» не выдаются (C-010, C-018)
  level = age > params.stale.block_days ? block : age > params.stale.banner_days ? banner : fresh     # block: reason = stale
  return {level, unaccounted_minor: rate == null ? null : mul_div(rate, age, 1)}   # плашка: «не учтено ≈ rate·age»
```

Решения. **Двусторонняя уникальность** вместо жадного скоринга IDEA-02: автосовпадения — изолированные пары в двудольном графе кандидатов, поэтому результат не зависит от порядка ввода, а повторный вызов после удаления совпавших пар ничего не меняет. **Окно по классам**: `near` не снимает план — оба учитываются, консервативно. **Статус не хранится**, а выводится из `as_of` (кроме терминальных): откат журнала и replay в backtest не требуют переходов. **Просроченный доход** на `as_of` (в `worse` — плюс 14) — [ALG-02](alg-02-timeline-projection.md).

```pseudo
# ── v2: калибровка ──
lag_observations(matches) -> { flow_key: {lags[], ratios_bp[]} }:      # хронологически по дате факта, затем id
  для m в matches, m.facts ≠ ∅, не m.excluded:                          # excluded — пометка пользователя «выброс»
     p = m.plan;  f_last = последний из m.facts по date
     lags += f_last.date − p.date;  ratios_bp += round_div(10000·|Σ m.facts.amount_minor|, |p.amount_minor|)
  оставить по каждому ключу последние calib.window = 24
nearest_rank(sorted_asc, q) = sorted_asc[max(0, ceil_div(q·len, 100) − 1)]
ewma(xs, alpha_bp) -> int:                                              # миллионные доли единицы; xs хронологичен, не пуст
  s = xs[0]·10^6;  для x в xs[1..]: s = round_div(alpha_bp·x·10^6 + (10000 − alpha_bp)·s, 10000, half_even);  return s
shrink_to_prior(median, n, prior, k) = round_div(n·median + k·prior, n + k, half_even)
flow_calibration(lags, ratios_bp, prior = 7, k = 3, alpha_bp = 3000):
  n = len(lags);  если n == 0: return {n: 0};  s = sorted(lags)
  p50, p80, p90 = nearest_rank(s, 50), nearest_rank(s, 80), nearest_rank(s, 90)
  return { n, p50, p80, p90, p90_label: ceil_div(90·n, 100) == n ? «наибольшее из n» : null,
           ewma_days: round_div(ewma(lags, alpha_bp), 10^6), shrunk_days: shrink_to_prior(p50, n, prior, k),
           ratio_ewma_bp: round_div(ewma(ratios_bp, alpha_bp), 10^6), expected_ready: n ≥ 10 }
expected_lag(cal) = cal.expected_ready ? cal.p50 : null                 # D-04: иначе режим как plan; сжатое значение — подсказка интерфейса (C-053)
wilson(k, n, z_x100 = 196) -> {lo_pm, hi_pm}:                           # float только здесь; границы в ‰ — к ближайшему (C-049: числа REQ-055 «5,5–26,1 %» сохранены)
  k ∉ 0..n или n < 1: fail(E_SCHEMA);  z = z_x100/100;  p = k/n;  den = 1 + z·z/n
  c = (p + z·z/(2n))/den;  h = z·sqrt(p·(1−p)/n + z·z/(4n·n))/den
  return { lo_pm: max(0, floor(1000·(c − h) + 0.5)), hi_pm: min(1000, floor(1000·(c + h) + 0.5)) }
```

```pseudo
# ── v2: backtest как знали тогда (модуль backtest.mjs) ──
# state_at(journal, t) — функция ledger.mjs (единственная реализация, C-056): [e в journal: parse_date(e.recorded_at[0..10]) ≤ t]; задним числом внесённое невидимо
replay_state(journal, t) = reduce(effective_events(state_at(journal, t))) без фактов с датой > t        # будущее ещё не произошло, даже если запись введена заранее
backtest(journal, t0, h, opts) -> Report:                                            # opts = {H = backtest.h_days (30, гипотеза), band?, breach?, min_origins = 3, min_window_days = 14}
  full = reduce(effective_events(journal));  last = последний день posted;  B(t) = params.buffer_minor на t
  origins = [t0 + j·h для j ≥ 0, t0 + j·h ≤ last − h]                                # непересекающиеся окна: дни не независимы; начало до открытия operating-счёта — в skipped_origins
  для t в origins:
     A = analyze(replay_state(journal, t), {as_of: t, horizon_end: t + h})            # ws на t: версии правил и params на t; query — как в ALG-02
     F = A.series.plan.close[h];  W = A.series.worse.close[h];  N0 = A.series.plan.opening_minor;  act = actual_close(full, t + h)
     err += F − act;  abs_err += |F − act|;  abs_naive += |N0 − act|
     lo, hi = opts.band(A, t, h) если band — функция, иначе (min(F, W), max(F, W));  hits += (lo ≤ act ≤ hi)     # P10–P90 по ALG-10 подставляет вызывающий: montecarlo и backtest не зависят друг от друга
     w = min(opts.min_window_days, h + 1);  f_min = min A.series.plan.trough[0..w−1];  a_min = min фактического trough за те же дни      # ошибка минимума (REQ-185)
     если f_min ≠ 0: min_error += round_div(10000·(a_min − f_min), |f_min|)
  n = len(origins) − skipped_origins;  hidden = n < opts.min_origins                  # до 2–3 месяцев истории метрики скрыты (значения всё равно считаются)
  mae_minor = round_div(abs_err, n);  bias_minor = round_div(err, n)
  skill_pm = abs_naive == 0 ? null : 1000 − floor_div(1000·abs_err, abs_naive)
  для e в probes(full):                                                               # реальные расходы operating-счетов без is_obligation, is_estimate и переводов между своими счетами (list_probes)
     t = e.date − 1;  если t < t0: continue
     если e.date + H > last: censored += 1;  continue                                 # исход не наблюдён до конца журнала — проба не учитывается
     ctx_t = analyze(replay_state(journal, t), {as_of: t, horizon_end: e.date + H})
     если |e.amount_minor| (в валюте решения) < θ = ctx_t.params.wave.threshold_minor: continue                 # C-055
     ans = check_purchase(ctx_t, {parts: [{date: e.date, amount_minor: −e.amount_minor}]}, B(t))   # ALG-04
     если ans.kind ≠ ok: insufficient += 1;  continue                                 # «данных мало» не входит в метрики
     br = (opts.breach ?? default_breach)(full, e, opts.H, B(t))                      # исход — по REQ-176
     ans.verdict == OK: n_ok += 1, k_ok += br;   ans.verdict ∈ {FRAGILE, NO}: n_al += 1, k_al += not br;   ans.verdict == TIGHT: n_tight += 1      # TIGHT — ни в FRR, ни в cry-wolf
  return { n_origins: n, hidden, mae_minor, bias_minor, skill_pm, coverage: {k: hits, n},
           frr: {k: k_ok, n: n_ok, bp: n_ok == 0 ? null : round_div(10000·k_ok, n_ok)},
           cry_wolf: {k: k_al, n: n_al, bp: n_al == 0 ? null : round_div(10000·k_al, n_al)}, insufficient,
           min_error: {n, mean_bp, mae_bp}, n_tight, censored, skipped_origins }
default_breach(full, e, H, B) = min_{d ∈ [e.date, e.date + H]} actual_free(full, d) < B       # рабочее определение до первого замера (C-055); H = backtest.h_days = 30
actual_free(full, d) = actual_trough(full, d) − reserve_trough(full, d)                      # по полному журналу; trough дня — расходы раньше доходов

release_gate(reports):                                                                # гейт по сумме счётчиков по журналам, REQ-176 (C-055)
  K1, N1, K2, N2 = Σ frr.k, Σ frr.n, Σ cry_wolf.k, Σ cry_wolf.n
  return { pass: len(reports) ≥ 10 и N1 > 0 и N2 > 0 и 10000·K1 ≤ 500·N1 и 10000·K2 ≤ 5000·N2,
           n_journals, k1: K1, n1: N1, k2: K2, n2: N2, frr_bp, cry_wolf_bp, reasons[] }                # reasons — какие из условий не выполнены
```

Подача: любая доля — с `n` ([ALG-10](alg-10-uncertainty-monte-carlo.md): при `n < 20` — «k из n», при `n ≥ 20` — интервал Уилсона, границы в ‰ — к ближайшему; для нижнего квантиля при `ceil(q·n/100) = 1`, `q < 50` — подпись «наименьшее из n», зеркально «наибольшее из n», C-049); `MAE` и `skill` показываются как «ошибка в среднем X за N окон». Правило IDEA-46 «округлять границы наружу» относится к денежным границам веера при показе в укрупнённых единицах, не к вероятностям.

## Инварианты и свойства

1. **Разбиение**: каждый факт попадает ровно в одну из групп `matches ∪ partials ∪ doubles ∪ unmatched_facts`; каждый план — не более чем в одну пару.
2. **Идемпотентность** (TST-32): повторный вызов на планах без `matched` и фактах без использованных даёт тот же результат; порядок входов не влияет.
3. Автосовпадение сохраняет счёт, знак и валюту; после него при `d ≥ max(F.date, as_of)` баланс меняется ровно на `F − P` (D-06).
4. Монотонность статуса: если вхождение `overdue` при `as_of`, оно `overdue` при любом `as_of' ≥ as_of` (без правки плана).
5. `p50 ≤ p80 ≤ p90`, значения принадлежат выборке; `min ≤ ewma ≤ max`.
6. `shrink` лежит между `median` и `prior`; `n = 0` → `prior`; при росте `n` приближается к `median`.
7. `lo_pm ≤ round(1000·k/n) ≤ hi_pm`; ширина интервала убывает с `n` при фиксированной доле.
8. `state_at(t) ⊆ state_at(t')` при `t ≤ t'`; запись с `recorded_day > t` не меняет прогноз на `t`.
9. `unlogged_rate ≥ 0`; `unaccounted = rate · age` растёт с `age`.

## Сложность

Сопоставление: `O((P + F)·log(P + F) + C)` с индексом по `(счёт, валюта, знак)` и отсортированным окном дат (`C` — число кандидатных пар); наивно `O(P·F)`. Калибровка: `O(n log n)` на поток. Backtest: `O(T·(E + h))` на источники и `O(|probes|·(E + n_days))` на покупки — основная цена, полный пересчёт на каждую точку.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Расхождение ровно `tol` | `in_tol`, автосовпадение | неравенство нестрогое |
| `tol < d ≤ 2·tol`, один кандидат | «возможный двойник», оба учитываются | D-06 |
| `d > 2·tol` | кандидата нет, факт не сопоставлен | `far` |
| Два плана в окне у одного факта | очередь (`ambiguous`), автосовпадения нет | порядок не должен решать |
| Два факта на один план | оба в очереди (`contested`) | план закрывает один платёж |
| `Δдата = ±3` / `±4` | кандидат / не кандидат | окно включительно |
| Другая валюта, знак или счёт | не кандидат | D-06 |
| Частичный платёж | только по связи пользователя: `partials`, остаток остаётся `expected` | сумма «ниже допуска» — не частичный факт |
| `date + grace == as_of` | `expected`; `overdue` со следующего дня | `date + grace < as_of` |
| `n < 10` лагов | `expected_ready = false`, режим как `plan`; `shrunk_days` — подсказка | D-04 |
| Одно наблюдение | `ewma = x`, `p50 = p90 = x`, «наибольшее из 1» | выборка вырождена |
| Якорей нет (хотя бы у одного operating-счёта) / `days = 0` | `block`, `no_anchor` / наблюдение пропускается | возраст неизвестен (C-010); нет базы для скорости |
| `n_ok = 0` или `n_al = 0` | метрика `null`, гейт не пройден | нет замера |
| Покупка с вердиктом «данных мало» | в `insufficient`, не в FRR | D-22 |

## Тест-векторы

**TV-1. Сопоставление на G-001 (REQ-031, TST-40).** План `R-RENT@2026-11-25` −90000, `win = 3`, `tol = 500`; допуск `500·90000 = 45 000 000` (в единицах `d·10000`).

| Факт | Δдата | `d·10000` | Класс | Исход |
|---|---:|---:|---|---|
| −90000, 11-27 | +2 | 0 | `in_tol` | `matched`, `lag = 2`, `ratio_bp = 10000` |
| −94500, 11-27 | +2 | 45 000 000 | `in_tol` (граница) | `matched`, `ratio_bp = round_div(10000·94500, 90000) = 10500` |
| −95000, 11-27 | +2 | 50 000 000 | `near` (≤ 90 000 000) | возможный двойник |
| −100000, 11-27 | +2 | 100 000 000 | `far` | не сопоставлен |
| −90000, 11-27 при втором плане −90000 на 11-26 | +2 / +1 | 0 / 0 | два кандидата | очередь `ambiguous` |
| −90000, 11-26 и −90000, 11-27 при одном плане | +1 / +2 | 0 / 0 | у плана два факта | оба в очереди `contested` |

Доход `S-HOURLY` +279000 на 11-05, факт +270000 на 11-07: `d = 9000`, `90 000 000 ≤ 500·279000 = 139 500 000`, а также 270000 внутри коридора 240000…330000 → `matched`; `lag = 2`; `ratio_bp = round_div(10000·270000, 279000) = 9677`; баланс с 11-07 ниже плана на `270000 − 279000 = −9000`.

**TV-2. Жизненный цикл (REQ-032, TST-41).** Доход на 2026-10-15: `as_of = 10-18` → `10-15 + 3 = 10-18`, не `< 10-18` → `expected`; `as_of = 10-19` → `overdue`. `S-HOURLY` (11-05): `as_of = 11-08` — `expected`, `11-09` — `overdue`; дата в потоке: `plan` — 11-09, `worse` — `11-09 + 14 = 11-23` (ALG-02).

**TV-3. Калибровка (REQ-053, TST-50).** Лаги по времени `[0, 3, 7, 5, 14, 6, 2, 9]`, отсортировано `[0, 2, 3, 5, 6, 7, 9, 14]`: `p50` — индекс `ceil_div(400, 100) − 1 = 3` → 5; `p80` — `ceil_div(640, 100) − 1 = 6` → 9; `p90` — `ceil_div(720, 100) − 1 = 7` → 14, «наибольшее из 8». `ewma(…, 3000) = 6 261 581` → `ewma_days = 6`. `shrink_to_prior(5, 8, 7, 3) = round_div(40 + 21, 11) = round_div(61, 11) = 6`. `n = 8 < 10` → `expected_ready = false`. Добавим лаги 4 и 8: `[0, 2, 3, 4, 5, 6, 7, 8, 9, 14]`, `n = 10` → `p50` — индекс 4 → 5; в `expected` доход 11-05 приходит 11-10. Новый клиент `[10, 12]` (C-052): `p50` по nearest-rank = `sorted[ceil_div(2·50, 100) − 1] = sorted[0] = 10`; `shrink_to_prior(10, 2, 7, 3) = round_div(2·10 + 3·7, 5) = round_div(41, 5) = 8` (прежнее 9 получалось по среднему 11, а не по nearest-rank). `shrink_to_prior` — подсказка интерфейса; дату в `expected` сдвигает только `lag_p50` при `n_obs ≥ 10` (C-053).

**TV-4. Интервал Уилсона, `z = 1,96`.**

| `k`/`n` | `lo_pm`…`hi_pm` | Подача |
|---|---|---|
| 1/8 | 22…471 | «в 1 из 8»; 2,2–47,1 % скрыт |
| 2/8 | 71…591 | «в 2 из 8»; 7,1–59,1 % скрыт |
| 3/24 | 43…310 | ≈ 12,5 % (95 %: 4,3–31,0 %) |
| 5/40 | 55…261 | ≈ 12,5 % (95 %: 5,5–26,1 %) |
| 0/20 | 0…161 | ≈ 0 % (95 %: 0–16,1 %) |
| 9/200 | 24…83 | ≈ 4,5 % (95 %: 2,4–8,3 %) |

**TV-5. Свежесть (REQ-027, TST-57).** Расхождения 8400 за 7 дней и 15000 за 10: `round_div(8400, 7) = 1200`, `round_div(15000, 10) = 1500`; `unlogged_rate = round_div(2700, 2) = 1350`. `age = 7` — `fresh`; `age = 9` — `banner`, не учтено `1350·9 = 12150` (121,50 €); `age = 22` — `block` (`stale`), вердикт Q3 → «данных мало», Q1 отвечает. Несколько счетов (C-010): якорь счёта A — 2026-10-04 (возраст 0), счёта B — 2026-09-12 (возраст 22) → `anchor_age = 22`, уровень `block`, `stale_accounts = [B]`, `drift` — сумма расхождений по счетам. Счёт C без якоря → `anchor_age = null`, `block`, `no_anchor`.

**TV-6. Backtest.** Учебные окна `h = 7` (не G-001): план `F = [340000, 300000, 280000, 250000]`, факт `A = [335000, 310000, 280000, 241000]`; `Σ|F − A| = 5000 + 10000 + 0 + 9000 = 24000`, `mae_minor = 6000`, `bias_minor = round_div(5000 − 10000 + 0 + 9000, 4) = 1000`. Наивный прогноз (баланс не меняется) `[400000, 340000, 300000, 280000]`: `Σ = 65000 + 30000 + 20000 + 39000 = 154000`; `skill_pm = 1000 − floor_div(24000000, 154000) = 1000 − 155 = 845`. Коридор `plan`–`worse` `[330000…340000], [290000…300000], [270000…280000], [240000…250000]` содержит факт в трёх окнах из четырёх: «в 3 из 4». **На G-001**: вопрос 10-04 о дорожке 300,00 € на 10-12 даёт `FRAGILE` (`m_after` plan 63500 ≥ 50000, worse 41000 < 50000). Журнал А — доход пришёл вовремя: фактический минимум `free` после покупки `93500 − 30000 = 63500 ≥ 50000`, пробоя нет, тревога зря. Журнал Б — лаг 14: `71000 − 30000 = 41000 < 50000`, пробой есть (окно `H` в примере — до конца горизонта, 49 дн., чтобы пробой 11-14 попал в окно; при рабочем `backtest.h_days = 30` (гипотеза, C-055) окно покупки 10-12 закончилось бы 11-11 и пробоя не увидело — поэтому значение `H` подлежит замеру, REQ-176). Пул: `cry_wolf = 1 из 2 = 5000 bp`; `n_ok = 0` → FRR `null`; журналов 2 < 10 → гейт не оценивается. Иллюстрация REQ-176: 200 `OK`, из них 9 с пробоем → 450 bp (проходит); 120 `FRAGILE|NO`, 66 без пробоя → 5500 bp (не проходит).

## Варианты и альтернативы

Жадный скоринг по `|ΔD|/win + |ΔA|/tol` (IDEA-02), оптимальное назначение (венгерский алгоритм) и сопоставление по тексту описания отвергнуты: первое зависит от порядка, второе избыточно для окна в 3 дня, третье вводит недоверенный текст в логику ([ADR-013](../decisions/adr-013-prompt-injection-policy.md)). Параметрический подбор лага (логнормальный) — [ALG-10](alg-10-uncertainty-monte-carlo.md).

| Продукт | Что есть | Что не найдено |
|---|---|---|
| Budget Guru | сопоставление и калибровка в источниках не описаны (не подтверждено) ([разбор](../tools/budget-guru.md)) | не проверено |
| [PocketSmith](../tools/pocketsmith.md) | сопоставление транзакции и события по периоду (возможен двойной учёт); кнопка «Fix this bill» для ранних оплат (июнь 2026); флаги разницы факта и плана | окно и допуск суммы как параметры; калибровка |
| [Actual Budget](../tools/actual-budget.md) | расписания: приблизительная сумма (совпадение в пределах ±7,5 %), автопроводка или подтверждение | единый класс «возможный двойник» |
| [Firefly III](../tools/firefly-iii.md) | подписки с мин./макс. суммой и ожидаемой датой; статусы `expected → matched → overdue` описаны у стороннего ff3e | калибровка по факту |
| [Float](../tools/business-cashflow-tools.md) | Smart Expected Dates по поведению клиента (закрыто); Forecast Confidence — 3 месяца факта против 6 месяцев прогноза, границы не опубликованы | открытая формула, backtest |
| [hledger](../tools/plain-text-accounting.md) | утверждения баланса (assertions) — аналог якоря | допуск, статусы вхождений |

### Не в v1

В продукте v1 — только сопоставление, статусы и свежесть данных. Калибровка (EWMA, nearest-rank, сжатие к prior), режим `expected`, интервал Уилсона и интерфейс backtest — v2; сам backtest — инструмент прототипа и гейт релиза v1 (REQ-176) на ≥ 10 журналах добровольцев, не экран продукта ([ADR-015](../decisions/adr-015-v1-slice.md)). Привязка факта к плану вручную (`plan_ref`) и пометка «не относится к плану» (`no_plan`) — записи журнала `match.set` (C-051), частичные платежи — часть очереди подтверждения; оповещения о просрочке — v2.

## Реализация в прототипе

**Статус: реализовано** — слои 1–2 (`calibration.mjs`) и слой 3 (`backtest.mjs`). Оговорка: гейт релиза REQ-176 в прототипе проверяется на **синтетических** журналах (`data/synthetic-journals/`), журналов добровольцев нет; пороги (30 дн., 14 дн., 5 %, 50 %) остаются гипотезами, вердикт гейта на реальных данных не получен. Сверено с кодом и тестами 2026-10-04: числа TV-1…TV-6 пересчитаны вызовом функций — все сошлись; обновлено 2026-10-27 по сквозному прогону 2026-10-28 (194 файла, 3452 теста; [руководство по прототипу](../product/15-prototype-guide.md)).

**Модули.** `prototype/engine/calibration.mjs` — зависит только от `money`, `dates`; реэкспортируется из `index.mjs`. `prototype/engine/backtest.mjs` — зависит от `money`, `dates`, `timeline`, `sinking`, `tax`, `fx`, `afford`, `index`, `ledger`; из `index.mjs` не реэкспортируется, ниже `index` его никто не импортирует (§14 B4, проверяет TST-60). `state_at` в этих модулях **нет**: единственная реализация — `ledger.mjs`, `backtest` вызывает `ledger.state_at` (C-056); `nearest_rank` определён в `calibration` и реэкспортируется из `montecarlo.mjs` (C-050).

```js
// calibration.mjs
CALIBRATION_DEFAULTS // 'match.window_days': 3, 'match.tol_bp': 500, 'grace_days.income': 3, 'grace_days.expense': 0, 'stale.banner_days': 7,
                     // 'stale.block_days': 21, 'calib.window': 24, 'calib.prior': 7, 'calib.k': 3, 'calib.alpha_bp': 3000 (плоские ключи или вложенные params)
dev_class(x, plan, tol_bp) -> 'in_tol' | 'near' | 'far'                                // BigInt, без деления
match_plan_to_fact(plans, facts, params) -> { matches[{plan, facts, by}], doubles[{fact, candidates, reason}], partials[{plan, facts, residual}], unmatched_plans, unmatched_facts }
classify_occurrence(plan, as_of, params) -> status ; assign_statuses(planned, facts, as_of, params) -> CashEvent[]   // копии в порядке входа
flow_key(e) -> string ; unlogged_rate(drifts) -> Minor | null ; stale_status(age, rate, params) -> { level, reason?, unaccounted_minor }
lag_observations(matches, window = 24) -> { [flow_key]: { lags, ratios_bp } }
nearest_rank(sorted_asc, q) ; ewma(xs, alpha_bp) ; shrink_to_prior(median, n, prior, k) ; expected_lag(cal) -> int | null
flow_calibration(lags, ratios_bp, prior = 7, k = 3, alpha_bp = 3000) -> { n, p50, p80, p90, p90_label, ewma_days, shrunk_days, ratio_ewma_bp, expected_ready }
wilson(k, n, z_x100 = 196) -> { lo_pm, hi_pm }

// backtest.mjs
BACKTEST_DEFAULTS // 'backtest.h_days': 30, 'backtest.min_window_days': 14, 'calib.min_origins': 3
backtest(journal, t0, h, opts = {}) -> Report ; release_gate(reports) -> { pass, n_journals, k1, n1, k2, n2, frr_bp, cry_wolf_bp, reasons }
default_breach(full, e, H, B) -> bool ; replay_state(journal, t) -> State ; list_probes(full) -> [{ id, date, amount_minor, currency, account_id }]
actual_rows(full, from, to) -> { from, opening_minor, close[], trough[], reserve_trough[], free[] } ; actual_close(full, d) ; actual_trough(full, d) ; reserve_trough(full, d) ; actual_free(full, d)
window_metrics(windows) -> { n, mae_minor, bias_minor, skill_pm, hits }
```

**Тесты** ([стратегия тестирования](../product/11-testing-strategy.md)):

| Файл | Что покрывает |
|---|---|
| `tests/calibration.test.mjs` (28) | TST-40 ×7 — TV-1 (аренда −90000 на 11-25, факты на 11-27), `ambiguous` / `contested`, окно ±3, S-HOURLY, связь `plan_ref` и частичные платежи; TST-41 ×2 — TV-2; TST-32 ×2 — идемпотентность; TST-57 — TV-5; TST-50 ×5 — TV-3 (nearest-rank, EWMA, сжатие, новый клиент C-052); TST-49/50 — TV-4 (Уилсон); `dev_class`, `lag_observations`, `flow_key`, значения по умолчанию против `vocab.json` |
| `tests/backtest.test.mjs` (32) | TST-55 ×27 — гейт REQ-176 (200/9 → 450 bp проходит; 120/66 → 5500 bp нет; 1 из 19 / 1 из 20; сумма счётчиков), TV-6 (MAE 6000, bias 1000, skill 845, покрытие 3 из 4), `actual_rows` (резервы, налог на лету, якорь, переводы), `replay_state`, G-001: покупка 300 € → `FRAGILE`, минимум `free` 63500 / 41000, `default_breach`, генератор синтетических журналов, форма отчёта, `opts.breach`, `opts.band`, `insufficient`, `skipped_origins`, `min_error`; TST-60 ×4 — слои §14 B4, чистота; TST-33 — детерминизм генератора |
| `tests/adversarial/verifier_io.test.mjs`, раздел «КАЛИБРОВКА» (15) | TST-50 — `nearest_rank` против оракула (n = 1…40, q = 0…100), Уилсон против BigInt-оракула (n = 1…150, все k), EWMA на 2000 случайных рядах, `shrink_to_prior`; TST-49/57/40/41/33 |
| `tests/adversarial/golden_properties.test.mjs` | свойства `nearest_rank`, `wilson`, `shrink_to_prior` |
| `tests/reconcile.test.mjs` (28), `tests/reconcile_boot.test.mjs` (4) | FP-11: допуски REQ-031 (−90000 и −94500 сопоставляются сами, −95000 — «возможный двойник», −100000 не сопоставлен), `ambiguous` / `contested`, доход «ожидается → просрочено» (REQ-032), действия экрана «Сверка» и «Отменить» на настоящем `app.mjs` (заглушка DOM) |
| `tests/quality_report.test.mjs` (17), `tests/anonymize.test.mjs` (11), `tests/mc_inputs.test.mjs` (11), `tests/expected.test.mjs` (6), `tests/band_adapter.test.mjs` (11) | экран «Качество прогноза» и зеркало отчёта (счётчики совпадают с замком `backtest.test`), анонимизация, входы вероятностных расчётов, ряд «ожидаемый», адаптер коридора |
| `tests/metrics_feed.test.mjs` (31), `tests/fp22_adv.test.mjs` (9), `tests/fp11_adv.test.mjs` (11, один `todo`) | окна прогноза → `min_error_bp` и покрытие (числа вручную: минимум 3 775,00 €, +596 bp при нулевых тратах), состязательные пробы; `todo` ADV-6 (анонимизация и метрики) |
| `tests/hardening.test.mjs` (40, один пропущен), `tests/properties.test.mjs` (13) | Q-28 (`skill` по BigInt совпадает с прежней формулой и точен при больших суммах); FP-24: инвариант TST-32 (повторное сопоставление на всех плановых вхождениях окна: пара не дважды, остаток без новых пар, статус `matched` идемпотентен) на 1000 журналах, в 528 из которых есть пара «план ↔ факт» |

Гейт на синтетических журналах (вывод тестов 2026-10-04; демонстрация метрики, не данные пользователей): 12 «обычных» журналов — FRR 1 из 117 = 85 bp, cry-wolf 7 из 18 = 3889 bp, гейт проходит; 10 «стресс»-журналов (клиент платит на 30–60 дней позже) — FRR 7 из 32 = 2188 bp, гейт не проходит.

**Псевдокод ≠ код** (результат сверки; «стр.» — исправлена страница, «код» — код оставлен как есть):

| № | Страница (до сверки) | Код | Решение |
|---|---|---|---|
| 1 | `backtest`, `release_gate`, `default_breach` лежат в `calibration.mjs` | вынесены в `backtest.mjs` (§14 B4) | стр. |
| 2 | срез «как знали тогда» — `reduce(effective_events(state_at(journal, t)))` | `replay_state`: дополнительно отбрасывает факты с датой после `t` (введённые заранее) | стр. |
| 3 | `opts.band == p10_p90` строит коридор внутри | `band` — функция вызывающего (слои: `montecarlo` и `backtest` не зависят друг от друга); по умолчанию `[min(plan, worse), max]` | стр. |
| 4 | пробы: расходы без `is_obligation`/`is_estimate`, модуль суммы ≥ `θ` | плюс: только `operating`-счета, без переводов между своими; `θ` берётся на момент `t` в валюте решения; проба, чьё окно `H` выходит за конец журнала, — `censored` и не учитывается; `TIGHT` — в `n_tight` (ни в FRR, ни в cry-wolf); вопрос задаётся с `horizon_end = e.date + H` | стр. |
| 5 | `Report` из 9 полей, `release_gate -> {pass}` | плюс `min_error`, `n_tight`, `censored`, `skipped_origins`; у гейта — счётчики и `reasons` | стр. |
| 6 | факт с `plan_ref` на план вне очереди (терминальный, исчез) в описании не рассмотрен | уходит в `unmatched_facts`, автосопоставления не получает | стр. |
| 7 | `lag_observations(matches)` | `(matches, window = 24)`; пары с нулевой суммой плана пропускаются (нет базы для отношения) | дополнение кода |
| 8 | `skill_pm = 1000 − floor_div(1000·abs_err, abs_naive)` | сначала float: `Math.floor(1000·abs_err / abs_naive)` и суммы `Number`; с волны 1 (FP-02, Q-28) суммы модулей и произведение считаются на BigInt: `skill_pm = Number(1000n − 1000n·abs_err / abs_naive)` (деление целых с усечением — для неотрицательных то же, что `floor_div`) | исправлено в коде |

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1 (сопоставление, статусы, свежесть данных), а также калибровка, backtest и гейт. Что изменилось в ядре: `calibration.mjs` и `backtest.mjs` читают умолчания из `vocab.json` через `vocab.generated.mjs` (FP-17, REQ-019), ключи потоков из чужого журнала — обычные данные (`own_put`, Q-07), `window_metrics` считает `skill_pm` на BigInt (Q-28, строка 8 таблицы). Закрыты три пункта прежнего «Не сделано» (волна 2, FP-11, 2026-10-09): **(1) анонимизация** — `tools/anonymize.mjs`: `anonymize_journal(journal, {seed, shift_weeks, k_bp})` сдвигает даты на 7·N дней и умножает суммы на k ∈ [0,5; 2] (в bp 5000…20000, ненулевая сумма в ноль не обращается), `verify_anonymized` проверяет пару «до / после»; **(2) интерфейс** — экран «Сверка» (`reconcile.mjs`: очередь «просрочено» / «возможное совпадение» / «оплачено частично», действия «подтвердить», «привязать к плану», «не относится», «пропустить», «отменить платёж», все факты с пагинацией; привязка пишется записью журнала `match.set`) и экран «Качество прогноза» (`quality.mjs`: отчёт backtest на синтетических журналах с пометкой «Синтетика» — FRR, cry-wolf, число журналов и ответов, дата замера, решение гейта REQ-176 с причиной, волны REQ-188; карточка «Привычки платежей» при n ≥ 10 наблюдений потока); **(3) отчёт и коридор** — `tools/backtest_report.mjs` пишет `data/backtest-report.json` (`runway-backtest-report/1`, `--check` сверяет пересчёт), `engine/band_adapter.mjs` подключает коридор P10–P90 к backtest без нарушения слоёв (`mc_band_adapter`), `engine/mc_inputs.mjs` строит входы из истории, `engine/expected.mjs` даёт ряд «ожидаемый» как отображаемую оценку. Метрики качества попадают на устройство из окон прогноза: окно в 14 дней закрывается сверкой остатка, согласованной с фактами, и пишет `min_error_bp` и покрытие «k из n» в `runway-metrics/1` (`metrics_feed.mjs`, FP-22; на встроенных демо-наборах окна не открываются). Цифры гейта на синтетике прежние: 12 «обычных» журналов — FRR 1 из 117 = 85 bp, cry-wolf 7 из 18 = 3889 bp (гейт проходит); 10 «стресс» — FRR 7 из 32 = 2188 bp, cry-wolf 3 из 72 = 417 bp (гейт не проходит).

**Не сделано.** Журналов добровольцев нет, гейт REQ-176 и калибровка параметров волн (REQ-188) на реальных людях не измерены (FP-39 ждёт владельца); экран «Качество прогноза» показывает отчёт на синтетике, а backtest по журналу самого пользователя из интерфейса не запускается; режим `expected` как режим расчёта в `timeline` не включён (`mode = 'expected'` даёт `E_SCHEMA`, `mode_not_in_v1`; `expected_lag` лишь возвращает лаг, сдвиг — только в отображаемом ряду). **Открытый `todo` ADV-6** (`fp11_adv`): анонимизация сдвигает даты на число дней, кратное 7, а `by_monthday` правил и граница потока «конец месяца» остаются на месте, поэтому метрики backtest на анонимизированном журнале могут отличаться от исходных; `anonymize_journal` возвращает `notes`, командная строка печатает предупреждение, а гейт по анонимизированным журналам стоит считать только после сравнения метрик «до и после» (решение — за владельцем, FP-39). Замечание по коду остаётся для `min_error`: произведение `10000·(a_min − f_min)` перед `round_div` — обычное `Number` (значения верны, пока оно меньше 2^53, то есть при разности минимумов до ≈ 9·10⁹ €), правило «деньги и деление — только через `money.mjs`» там нарушено; для `skill_pm` это исправлено (Q-28).

## Связанные страницы

- [ALG-02 проекция](alg-02-timeline-projection.md), [ALG-10 Монте-Карло](alg-10-uncertainty-monte-carlo.md), [ALG-04 «могу ли я купить»](alg-04-can-i-afford.md), [ALG-07 почасовой доход](alg-07-hourly-income.md)
- [ADR-006 семантика прогноза](../decisions/adr-006-forecast-semantics.md), [ADR-008 неопределённость](../decisions/adr-008-uncertainty-scenarios-monte-carlo.md), [ADR-004 журнал](../decisions/adr-004-event-journal-projections.md)
- [Требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md), [PocketSmith](../tools/pocketsmith.md), [Actual Budget](../tools/actual-budget.md)
