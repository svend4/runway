---
title: "ALG-02: временная шкала и проекция остатка"
type: algorithm
status: reviewed
summary: "Как из фактов, планов и гипотез строится дневной ряд close/trough: опорный остаток, статусы, режимы plan/worse, сценарии, валюта решения, узкая точка, Q1, runway и объяснение «почему»."
sources: [_ops/design-brief.md, wiki/decisions/adr-006-forecast-semantics.md, wiki/decisions/adr-004-event-journal-projections.md, wiki/decisions/adr-003-civil-dates.md, wiki/ideas/proposal-engine.md, wiki/tools/pocketsmith.md, wiki/tools/actual-budget.md, wiki/tools/plain-text-accounting.md, wiki/tools/business-cashflow-tools.md]
updated: 2026-10-27
---

# ALG-02 Временная шкала и проекция остатка

## Назначение

Алгоритм превращает журнал, правила и гипотезы в два дневных ряда: `close` (остаток на конец дня) и `trough` (остаток после расходов дня, до его доходов). Ряды — вход для всех ответов: Q1 «хватит ли к дате», волны ([ALG-03](alg-03-payment-waves-detection.md)), Q3 и safe-to-spend ([ALG-04](alg-04-can-i-afford.md), [ALG-11](alg-11-safe-to-spend.md)), «почему» (IDEA-29).

Реализует REQ-014 (слои), REQ-020…024 (ряды, Q1, узкая точка, разрыв, режимы), REQ-030 (объяснение), REQ-049, REQ-050 (сценарии) в [требованиях](../product/02-requirements.md); идеи IDEA-01, IDEA-07, IDEA-23, IDEA-29; решения [ADR-003](../decisions/adr-003-civil-dates.md), [ADR-004](../decisions/adr-004-event-journal-projections.md), [ADR-006](../decisions/adr-006-forecast-semantics.md). Тесты: TST-01, 07, 09, 31, 34, 35, 36, 41, 53, 54 ([стратегия тестирования](../product/11-testing-strategy.md)). Понятие — [прогноз денежного потока](../concepts/cash-flow-forecast.md).

## Определения

Термины — по [глоссарию](../product/14-glossary.md). Сетка: дни `as_of .. horizon_end` включительно, `N = horizon_end − as_of + 1`, индекс `i = d − as_of`.

- `trough[i] = close[i−1] + out_i`, `close[i] = trough[i] + in_i`, `close[−1] := opening`; `out_i ≤ 0` — сумма расходов дня, `in_i ≥ 0` — сумма доходов. Порядок «расходы раньше доходов» один во всех режимах.
- **Слои**: `posted` уже внутри `opening`; в поток входят `planned` и `hypothetical`. План на дату `as_of` ещё «впереди» (день 0), факт на `as_of` — уже в остатке.
- **Эффективная дата** (режим — пакет параметров дат, не сценарий): `base(e) = max(e.plan_date, as_of)`, где `plan_date` — дата события после правок сценария и до режима, **без** зажима `max(·, as_of)` (C-005; зажим отнимал бы возраст просрочки); `plan`: `base`; `worse`: `base + (e.kind = income ? delay : 0)`, `delay = e.delay_days_worse ?? worse.income_delay_days ≥ 0`. Суммы и расходы не меняются. `expected` — v2.
- **Сценарий** — правки данных (`delay_income`, `shift_flow`, `set_amount`, `remove_flow`, `add_purchase`, `add_flow`) до применения режима; результат — функция `(данные, режим, сценарий)`. **Композиция с режимом (C-009):** сначала сценарий меняет `date` данных, затем режим добавляет свой сдвиг — накопление: `delay_income 7` в `worse` даёт 7 + 14 = 21 день; `delay_income 14` в `plan` равен ряду `worse`. Подпись в интерфейсе — «сдвиг сценария + сдвиг режима».
- **Узкая точка** — первая дата минимума ряда на отрезке; при равенстве — ранняя.
- **Q1** (D-13) — свойство *пути*: минимум `trough` на `[as_of, D]`, а не значение на `D`.
- Статусы вхождений и сопоставление с фактом — [ALG-13](alg-13-plan-vs-actual-calibration.md); курсы — [ALG-08](alg-08-fx-conversion.md); вхождения правил — [ALG-01](alg-01-recurrence-expansion.md); часы — [ALG-07](alg-07-hourly-income.md).

## Входы и выходы

| Вход / выход | Тип |
|---|---|
| `ws` | рабочая область: `accounts`, `rules`, `overrides`, `calendars`, `streams`, `planned_one_offs`, `scenarios`, `rates`, `params`, проекция журнала `js` (якоря, `posted`; `plan_ref`/`no_plan` у фактов проставляет свёртка записей `match.set`, C-051) |
| `query` | `{as_of: EpochDay, horizon_end: EpochDay, mode: plan или worse, scenario_id?: Id}` |
| `CashEvent` | `{cash_event_id, layer, account_id, date: EpochDay, amount_minor: int, currency, kind, status?, rule_id?, stream_id?, occ_key?, tag, is_obligation, is_estimate, delay_days_worse?, transfer_id?, scenario_id?, …}`; `stream_id` — у событий потока часов и бонусов (у них `rule_id = null`, C-025); служебное поле результата `plan_date` (дата после сценария и до режима, без зажима; вместо прежнего `base_date`, C-005; в журнал не пишется) |
| `Series` | `{from: EpochDay, opening_minor, close: int[N], trough: int[N]}`; `reserve_opening_minor`, `reserve_trough`, `reserve_close`, `free` добавляет `analyze` через `reserve_series` ([ALG-11](alg-11-safe-to-spend.md), C-012) |
| `Q1Answer` | `{min, at, ok_cash, ok_buffer, first_breach, first_buffer_breach, need, close_on_D}` или `{beyond_horizon: true}` |
| `Explanation` | `{point, peak, out_total_minor, inflow_offset_minor, chain[], counterfactuals[]}` |

Деньги — целые `amount_minor` в валюте решения; даты — `EpochDay`; расходы отрицательны.

## Алгоритм

Деление и округление — только через `round_div`, `mul_div` из design-brief §4 (здесь `round_div` нужен для долей в `bp`).

```pseudo
# ── money.mjs (вспомогательные) ───────────────────────────────────────────────
assert_minor(x): x не целое → fail(E_NOT_INTEGER);  |x| > 2^53 − 1 → fail(E_OVERFLOW);  return x
sum_minor(xs):   s = 0;  для x в xs: s = assert_minor(s + assert_minor(x));  return s

# ── timeline.mjs ─────────────────────────────────────────────────────────────
opening_state(ws, as_of) -> { opening_minor, drift, anchor_age, stale_accounts[] }      # C-010, C-034
  js = ws.js;  P = ws.params;  fx_ctx = { rates: ws.rates, decision_currency: P.decision_currency, policy: 'spot', rounding: P.rounding }
  balances = {};  drift = null;  oldest = null;  no_anchor = false;  stale_accounts = []
  для a в js.accounts: a.liquidity = operating, a.opened_on ≤ as_of, (a.closed_on = null или a.closed_on > as_of):
     anc  = последний якорь a с date ≤ as_of;  base = anc ≠ null ? anc.amount_minor : 0;  after = anc ≠ null ? anc.date : −∞
     posted(a) с date > as_of → fail(E_FUTURE_POSTED)
     balances[a] = base + Σ amount_minor по posted(a) при after < date ≤ as_of    # posted с date ≤ anc.date уже в якоре
     если anc ≠ null:                                                            # дрейф: расхождение якоря с проведёнными
        prev = предыдущий якорь a (или null);  pa = prev?.amount_minor ?? 0;  pd = prev?.date ?? −∞
        drift = (drift ?? 0) + to_decision(anc.amount_minor − (pa + Σ posted(a) при pd < date ≤ anc.date), a.currency, as_of, fx_ctx).amount_minor   # по счетам суммируется
        oldest = oldest = null ? anc.date : min(oldest, anc.date);  age_a = as_of − anc.date
     иначе: no_anchor = true;  age_a = null                                      # у счёта без якоря возраст неизвестен
     если age_a = null или age_a > P.stale.banner_days: stale_accounts += [{ account_id: a.account_id, age: age_a }]    # для плашки
  total = opening_in_decision(js.accounts, balances, fx_ctx, as_of)             # spot, ALG-08; нет курса → E_NO_RATE
  # anchor_age — по самому несвежему operating-счёту: as_of − min(дата последнего якоря); счёт без якоря → null (stale_status: block, no_anchor)
  return { opening_minor: assert_minor(total), drift, anchor_age: (no_anchor или oldest = null) ? null : as_of − oldest, stale_accounts }   # пороги плашек — ALG-13

plan_from(ws, a, as_of) = (последний якорь a с date ≤ as_of)?.date ?? as_of      # C-004: от даты якоря ВКЛЮЧИТЕЛЬНО; план до якоря уже учтён в якоре

eff_date(e, mode, params, as_of) -> EpochDay | null
  если e.status ∈ {matched, skipped, cancelled}: return null                     # в поток не входят (D-06)
  base = max(e.plan_date, as_of)                                                 # просроченный/«прошлый» план считается на as_of; plan_date — без зажима (C-005)
  plan:  return base
  worse: d = e.kind = income ? (e.delay_days_worse ?? params.worse.income_delay_days) : 0
         d не целое или d < 0 → fail(E_SCHEMA);  return base + d
  expected: fail(E_SCHEMA, {reason: 'mode_not_in_v1'})                           # v2: base + lag_p50(flow_key) при n_obs ≥ 10

build_events(ws, query) -> CashEvent[]               # эффективные события режима; posted в результат не входят
  P = ws.params;  (as_of, horizon_end, mode) = query
  pf(a) = plan_from(ws, a, as_of);  f0 = min(as_of, pf(a) для operating-счетов a)       # окно плана счёта — с даты его якоря включительно (C-004)
  # 1. план: правила (ALG-01), потоки часов (ALG-07), разовые, графики долгов и рассрочек (ALG-09)
  occ     = expand_all(ws.rules, {from: f0, to: horizon_end}, ws.calendars, ws.overrides)
  planned = [cash_event(o, planned, status = expected) для o в occ] + expand_stream(s, {from: f0, to: horizon_end}, ws.calendars[s.calendar_id]) для s в ws.streams
            + [e в ws.planned_one_offs: f0 ≤ e.date ≤ horizon_end]
            + [e в schedule_to_events(d) для d в ws.debts: f0 ≤ e.date ≤ horizon_end]      # C-039: платежи графика — плановые обязательства (по ALG-09 — v1.1, в прототипе уже есть)
  planned = [e в planned: e.date ≥ pf(e.account_id)]
  # 2. сопоставление с фактом (ALG-13): match_plan_to_fact → matched / residual; иначе classify_occurrence → expected | overdue
  facts   = posted с датой в [f0 − P.match.window_days, as_of]
  planned = assign_statuses(planned, facts, as_of, P)                            # частичный факт: amount_minor := остаток плана
  planned = [e в planned: e.status ∉ {matched, skipped, cancelled}]
  # 3. сценарий — правки данных ДО режима
  ctx = { as_of, horizon_end, calendars: ws.calendars, default_account_id: первый operating-счёт в валюте решения }
  evs = query.scenario_id = null ? planned : apply_scenario(planned, ws.scenarios[query.scenario_id], ctx)
  # 4. только operating; переводы между operating (обе ноги по transfer_id) исключаются; в неоперационный — остаётся ногой-расходом
  evs = [e в evs: account(e).liquidity = operating];  evs = drop_internal_transfers(evs)
  # 5. валюта решения (ALG-08, политика spot)
  evs = to_decision_events(evs, ws.accounts, ws.rates, P.decision_currency, 'spot', as_of)      # C-034: сигнатура ALG-08, policy 'spot' и as_of
  # 6. режим
  для e в evs: e.plan_date = e.date                                              # C-005: дата после сценария, до режима, без зажима
               d = eff_date(e, mode, P, as_of);  если d = null или d > horizon_end: continue;  out += [{...e, date: d}]
  return stable_sort(out, ключ (date, amount_minor, cash_event_id))

resolve(evs, ref) -> CashEvent[]                       # event_ref — одна строка (C-008): сначала точное cash_event_id / occ_key, затем rule_id / stream_id
  hit = [e в evs: e.cash_event_id = ref или e.occ_key = ref]
  hit пуст: hit = [e в evs: e.rule_id = ref или e.stream_id = ref]                 # все вхождения правила / потока в окне событий
  hit пуст → fail(E_SCHEMA);  return hit                                          # нет совпадения — ошибка, не молчаливый пропуск

apply_scenario(events, scenario, ctx) -> CashEvent[]   # ctx = {as_of, horizon_end, calendars, default_account_id}; default_account_id — первый operating-счёт в валюте решения (null-счёта нет)
  evs = копия events;  n = 0
  для op в scenario.ops по порядку:  n += 1
    delay_income{ref, days}: hit = resolve(evs, ref);  |hit| ≠ 1 → fail(E_SCHEMA);  e = hit[0];  e.kind ≠ income или days < 0 → fail(E_SCHEMA);  e.date += days
    shift_flow{ref, days}:   для e в resolve(evs, ref): e.date += days            # days — любое целое; допускает rule_id / stream_id (все вхождения в окне)
    set_amount{ref, amount_minor}: hit = resolve(evs, ref);  |hit| ≠ 1 → fail(E_SCHEMA);  знак совпадает с kind, иначе fail(E_SCHEMA);  e.amount_minor = amount_minor;  e.amount_min/max = null
    remove_flow{ref}:        удалить resolve(evs, ref) (rule_id / stream_id выбирает все вхождения)
    add_purchase{parts}:     evs += purchase_to_events({purchase_id: 'scn:'+scenario_id+':'+n, currency: валюта ctx.default_account_id, parts}, ctx.default_account_id, scenario.scenario_id)
    add_flow{once | rule}:   once → одно hypothetical-событие;  rule → expand_rule(rule, {from: ctx.as_of, to: ctx.horizon_end}, ctx.calendars[rule.calendar_id], []) с id 'scn:'+id+':'+n+':'+occ_key
  изменённым событиям: scenario_id = scenario.scenario_id;  return evs               # правит данные (date, amount); сдвиг режима добавится позже, накопительно (C-009)

purchase_to_events(purchase, account_id, scenario_id?) -> CashEvent[]     # C-008: функция timeline.mjs (не afford.mjs: иначе цикл зависимостей timeline ← afford)
  [ { cash_event_id: purchase.purchase_id + '#' + k, layer: hypothetical, kind: expense, account_id, scenario_id, date: p.date, amount_minor: −p.amount_minor,
      currency: purchase.currency, tag: 'purchase', is_obligation: false, is_estimate: false, purchase_id: purchase.purchase_id }  для (k, p) ∈ purchase.parts ]

project(events, opening_minor, as_of, horizon_end) -> { from, opening_minor, close[], trough[] }
  N = horizon_end − as_of + 1;  N < 1 → fail(E_BAD_DATE);  out = [0]·N;  inn = [0]·N
  для e в events:
     assert_minor(e.amount_minor);  i = e.date − as_of
     i < 0 → fail(E_SCHEMA, {reason: 'event_before_as_of'});  i ≥ N → continue    # за горизонтом
     если e.amount_minor < 0: out[i] += e.amount_minor  иначе: inn[i] += e.amount_minor
  bal = assert_minor(opening_minor)
  для i в 0..N−1:  trough[i] = assert_minor(bal + out[i]);  bal = assert_minor(bal + out[i] + inn[i]);  close[i] = bal
  return { from: as_of, opening_minor, close, trough }

argmin_first(xs, lo, hi): idx = lo;  для i в lo+1..hi: если xs[i] < xs[idx]: idx = i;  return idx     # строго <: побеждает ранний
narrowest_point(series, a, b): i = argmin_first(series.trough, a − from, b − from);  return { date: from + i, amount_minor: trough[i] }

answer_q1(series, D, B) -> Q1Answer
  D < from → fail(E_BAD_DATE);  D > from + N − 1 → return { beyond_horizon: true }      # «в горизонте нет»
  idx = D − from;  k = argmin_first(trough, 0, idx);  m = trough[k]
  fb  = первый i ≤ idx с trough[i] < 0 (или null);  fbb = первый i ≤ idx с trough[i] < B (или null)    # даты from + i
  return { min: m, at: from + k, ok_cash: m ≥ 0, ok_buffer: m ≥ B, first_breach: fb, first_buffer_breach: fbb, need: max(0, B − m), close_on_D: close[idx] }

runway_days(series, events) -> { with, without }                  # C-005: два аргумента; opening_minor, as_of, horizon_end берутся из series
  as_of = series.from;  horizon_end = series.from + len(series.trough) − 1
  first_neg(tr) = первый i с tr[i] < 0 ? { date: as_of + i, days: i } : null                # null — «за горизонтом»
  s0 = project([e в events: e.amount_minor < 0], series.opening_minor, as_of, horizon_end)  # то же без поступлений
  return { with: first_neg(series.trough), without: first_neg(s0.trough) }                  # C-006: по trough на всём горизонте, не по close; with = first_breach(horizon_end)

explain_narrowest(events, series, params) -> Explanation
  k = argmin_first(trough, 0, N−1);  t = from + k;  m = trough[k];  h_end = from + N − 1
  pk = −1;  pv = series.opening_minor                                  # пик: максимум остатка до точки; кандидаты opening и close[0..k−1], при равенстве — раньше
  для j в 0..k−1: если close[j] > pv: pv = close[j];  pk = j
  peak = { date: from + max(pk, 0), amount_minor: pv };  w0 = from + pk + 1                 # окно цепочки: [w0, t]
  W = [e: e.amount_minor < 0, w0 ≤ e.date ≤ t];  Wi = [e: e.amount_minor > 0, w0 ≤ e.date < t]
  out_total = Σ |amount| по W;  offset = Σ amount по Wi                                     # peak − m = out_total − offset
  group_key(e) = e.rule_id ?? e.stream_id ?? (e.tag ≠ null ? 'tag:' + e.tag : e.cash_event_id)     # C-025; ключ 'tag:…' — только для экрана (C-097)
  G = группы W по group_key с суммой |amount|, по (сумма убыв., group_key возр.);  chain = [];  cum = 0
  для g в G: если |chain| = params.explain.top_k: break
     cum += g.sum;  chain += [{ group, count, amount_minor: g.sum, share_bp: round_div(10000·g.sum, out_total), cum_bp: round_div(10000·cum, out_total), event_ids }]
     если cum_bp ≥ params.explain.share_cutoff_bp: break                                   # накопленная доля считается от накопленной суммы
  cf = []                                                                                  # контрфакты — пересчёт движком, не моделью
  для c в chain: s2 = project(events без группы c.group, series.opening_minor, from, h_end);  (d2, m2) = narrowest(s2)
                 cf += [{ kind: without, group: c.group, new_min: {date: d2, amount_minor: m2}, delta_minor: m2 − m }]
  b(e) = max(e.plan_date, from)                                                            # base(e), C-005
  для e в доходов с e.date > b(e) и b(e) ≤ t, по убыванию суммы, не более top_k:            # C-007: контрфакт no_delay
                 s2 = project(events, где e.date := b(e), …);  cf += [{ kind: no_delay, event_id, new_min, delta_minor }]
  return { point: {date: t, amount_minor: m}, peak, out_total_minor: out_total, inflow_offset_minor: offset, chain, counterfactuals: cf }

# C-022 (X1, X6): один набор исходящих для порога волны и подсказки буфера
outflow_90(ws, as_of) -> Minor | null:
  P = ws.params;  fx_ctx = { rates: ws.rates, decision_currency: P.decision_currency, policy: 'spot', rounding: P.rounding }
  X = [e в posted: as_of − 90 ≤ e.date < as_of, e.amount_minor < 0, e не перевод между своими счетами, не налоговый платёж, не нога обмена валют, не e.is_exceptional]
  X пуст → return null                                                                     # нет истории
  return Σ |to_decision(e.amount_minor, e.currency, as_of, fx_ctx).amount_minor| по X
buffer_hint(ws, as_of) = (o = outflow_90(ws, as_of)) = null ? null : round_div(ws.params.buffer_hint_days · o, 90)             # G-001: round_div(7 · 630000, 90) = 49000
default_wave_threshold(ws, as_of) = max(30 · 10^currency_exponent(ws.params.decision_currency), (o = outflow_90(ws, as_of)) = null ? 0 : round_div(o, 300))   # G-001: max(3000, 2100) = 3000
```

Ключевые решения. (1) Режим применяется **после** сценария и **накапливается** с ним (C-009): `delay_income` на 14 дней в `plan` даёт тот же ряд, что режим `worse` (REQ-050); `delay_income` на 7 дней в `worse` сдвигает доход на 21 день. `run_scenario` ассистента по умолчанию считается в `plan`, чтобы это не удивляло (C-075). (2) Опорная точка — последний якорь; окно плана счёта начинается с даты якоря включительно (`plan_from`, C-004), план до якоря уже учтён в якоре, план после якоря без сопоставленного факта считается на `as_of` ([ALG-13](alg-13-plan-vs-actual-calibration.md)); свежесть — по самому несвежему operating-счёту, у счёта без якоря возраст неизвестен (C-010). Служебное поле `plan_date` (дата до режима, без зажима `max(·, as_of)`) заменило `base_date`, `base(e) = max(plan_date, as_of)` вычисляется на месте (C-005); `runway_days` считается по `trough` на всём горизонте (C-006). Ряды резервов, `free` и `reserve_opening_minor` добавляет `analyze` — единый контекст `ctx` для `waves`, `afford`, `tools` (C-012); `purchase_to_events` живёт здесь, в `timeline`, а не в `afford` (C-008). (3) `project` ничего не знает о резервах и валютах: она линейна по событиям, поэтому сценарий аддитивен, а локальная правка меняет только хвост. (4) Контрфакты и цепочка — полный пересчёт `project`: `O(k·(N+M))` без деревьев отрезков (C23). Группа цепочки по `tag` содержит недоверенный текст: в `Result` инструмента `explain_min_point` поле `group` — идентификатор (`rule_id`/`stream_id`/`cash_event_id`) плюс `cause_class`, ключи `tag:…` остаются только в ответе движка для экрана (C-097, ADR-013). (5) Налоговый платёж `P-TAX1` — сумма, введённая пользователем; расчёт по введённым правилам, не консультация.

## Инварианты и свойства

1. Сохранение: `close[i] − close[i−1] = out_i + in_i`, `close[−1] = opening` (TST-31).
2. `trough[i] ≤ close[i−1]`, `trough[i] ≤ close[i]`, `trough[0] ≤ opening`.
3. `trough_worse[i] ≤ trough_plan[i]` и `close_worse[i] ≤ close_plan[i]` при `delay ≥ 0` (TST-35).
4. Добавление расхода не повышает ни один ряд; убирает доход — не повышает.
5. Локальность: правка события на дату `d` не меняет `close`, `trough` до `idx(d)` (TST-34); `trough[idx(d)]` меняется только при расходе.
6. Аддитивность: ряды `base ⊎ Δ` = ряды `base` + ряды `Δ` при `opening = 0` — для `close` и `trough` покомпонентно (TST-36).
7. `min trough` на `[as_of, D]` не возрастает с ростом `D`; `first_breach` не зависит от `D`, пока попадает в путь.
8. `explain`: `peak − point = out_total − inflow_offset`; доли — целые `bp`, накопленная доля неубывает.
9. Детерминизм: те же входы дают побайтно те же ряды (нет часов, нет обхода `Map` без сортировки).

## Сложность

`project` — `O(N + M)` по горизонту `N` и числу событий `M`; память `O(N)`. `build_events` — `O(R·K + M log M)` плюс `assign_statuses` (локален: только планы у `as_of`). `answer_q1`, `runway_days` — `O(N + M)`. `explain_narrowest` — `O((top_k + d)(N + M))`, `d` — число задержанных доходов. Целевой бюджет — `N·M = 180 × 10³` (TST-54): полный пересчёт, без инкрементальных структур; узкое место — многократные `project` в объяснении и в [Монте-Карло](alg-10-uncertainty-monte-carlo.md) (v2).

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Доход и расход в один день | суммируются; `trough = bal + out`, `close = bal + out + in` | порядок «расходы раньше доходов» |
| Нет событий | `trough = close = opening` на всём ряду | нет `out`, `in` |
| `as_of = horizon_end` | `N = 1`, одна точка | сетка включительная |
| Событие позже `horizon_end` | не входит; `answer_q1` для такой даты — `beyond_horizon` | ответ «в горизонте нет» |
| `posted` с `date > as_of` | `E_FUTURE_POSTED` | факт из будущего |
| План в прошлом без факта | считается на `as_of`; в `worse` доход — `as_of + delay` | D-04, `expected → overdue` |
| `matched`, `skipped`, `cancelled` | события нет; частичный факт — остаток плана | D-06 |
| Перевод между operating-счетами | обе ноги исключены; в неоперационный — остаётся расходом | нетто 0, D-07 |
| `delay_days_worse < 0` | `E_SCHEMA` | нарушил бы `worse ≤ plan` |
| Сценарий ссылается на исчезнувшее событие | `E_SCHEMA`, интерфейс объясняет | молчаливый пропуск скрывал бы расхождение |
| `delay_income` / `set_amount` с `ref`, выбирающим несколько событий (`rule_id`, `stream_id`) | `E_SCHEMA` | эти операции требуют одно событие (C-008); `shift_flow`, `remove_flow` допускают группу |
| Плановое вхождение раньше даты последнего якоря счёта | в поток не входит; на дату якоря — входит | учтено в якоре (C-004) |
| У operating-счёта нет якоря | `anchor_age = null`, уровень `block`, причина `no_anchor`; счёт попадает в `stale_accounts` | возраст неизвестен (C-010) |
| `delay_income 7` в режиме `worse` | доход сдвинут на 21 день | накопление сценария и режима (C-009) |
| Минимум держится несколько дней | узкая точка — первая дата | при равенстве побеждает ранняя |
| Отрицательный `opening` | допустим, `ok_cash = false` | расчёт честный, остаток вводит пользователь |
| Нет курса для валюты события | `E_NO_RATE` | [ALG-08](alg-08-fx-conversion.md) |
| `out_total = 0` в объяснении | цепочка пуста | узкая точка — сам остаток |
| Сумма вышла за `2^53 − 1` | `E_OVERFLOW` | `assert_minor` на каждом шаге |

## Тест-векторы

Все векторы — G-001, **горизонт 57 дн.** (`as_of` 2026-10-04 = 20730, `horizon_end` 2026-11-30 = 20787, `N = 58`), буфер `B = 50000`; события — вхождения правил из [ALG-01](alg-01-recurrence-expansion.md), налог −50000 на 10-23, поток `S-HOURLY` +279000 на 11-05, `opening = 400000`.

**TV1. Ряды.** `plan`: 10-09 `397500` (400000 − 2500); 10-10 `387500`; 10-17 `377500`; 10-23 `327500` (−50000); 10-24 `317500`; 10-26 `215500` (−102000); 10-31 `205500`. На 11-05: `trough = 205500`, `close = 205500 + 279000 = 484500`; 11-07 `474500` … 11-30 `340000`. `worse`: доход `base 11-05 + 14 = 11-19`; `trough`: 11-07 `195500`, 11-09 `193000`, 11-14 `183000`, 11-19 `183000` при `close = 462000`; 11-21 `452000`. Конец ряда в обоих режимах `340000 = 400000 − 339000 + 279000`.

**TV2. Q1** (`B = 50000`): к 2026-10-26 `min = 215500` на 10-26 в обоих режимах; к 11-05 — `205500` на 10-31; к 11-30 — `205500` (`plan`, 10-31) и `183000` (`worse`, 11-14); везде `ok_cash = ok_buffer = true`, `first_breach = null`, `need = 0`; `runway_with = runway_without = null` (расходы 339000 < 400000).

**TV3. G-001-gap** (`opening = 100000`): `min trough` `plan` −94500 · 10-31, `worse` −117000 · 11-14; на 10-26 `close[10-24] = 100000 − 2500 − 10000 − 10000 − 50000 − 10000 = 17500`, `trough = 17500 − 102000 = −84500`; `first_breach = 2026-10-26`, `first_buffer_breach = 2026-10-23` (27500 < 50000); `runway_with = 2026-10-26`, 22 дня; `need` к 11-30: 144500 / 167000.

**TV4. Сценарии.** `delay_income{S-HOURLY@2026-11-05, 21}` в `plan` (`ref` — `occ_key`; голый `S-HOURLY` выбрал бы все вхождения потока в окне, здесь оно одно): доход 11-26; `min trough = 71000` на 11-25 (205500 − 10000 − 2500 − 10000 − 10000 = 173000, затем −102000), изменение к базе `71000 − 205500 = −134500`. `delay_income{…, 14}` в `plan` = ряд `worse` по `trough` и `close` (TST-35, TST-36); `delay_income{…, 7}` в `worse`: `plan_date = 11-12`, эффективная дата `11-12 + 14 = 11-26` — тот же ряд, что `delay_income 21` в `plan` (C-009). `add_purchase` 30000 на 10-12: `min trough` `plan` 175500 (10-31), `worse` 153000 (11-14); ряды базы и дельты `−30000` с 10-12 складываются покомпонентно.

**TV5. Объяснение, `worse`.** Узкая точка 183000 на 11-14; пик 400000 на 10-04 (`opening`); `out_total = 217000`. Группы: аренда 90000 (`round_div(900000000, 217000) = 4147` bp), продукты 60000 (6 событий, 2765), налог 50000 (2304; у разового плана `P-TAX1` нет `rule_id` и `stream_id`, поэтому в ответе движка его группа — `tag:налог`, а в `Result` инструмента — идентификатор `P-TAX1`, C-097); накопленная доля считается от накопленной суммы: 90000 → 4147; 150000 → 6912; 200000 → **9217** ≥ 9000, стоп. Контрфакты: без аренды 273000 (11-14, +90000), без продуктов 243000 (11-09, +60000), без налога 233000 (11-14, +50000), доход без задержки 205500 (10-31, +22500).

**TV6. Малые случаи.** День 0: `opening = 10000`, `+50000` и `−30000` → `trough = −20000`, `close = 30000` (разрыв в течение дня при положительном `close`). Доход, план 2026-10-15, `grace = 3`: `as_of 10-18` → `expected` (10-15 + 3 = 10-18, не меньше `as_of`), `eff` в `plan` — 10-18, в `worse` — 11-01; `as_of 10-19` → `overdue`, `eff` — 10-19 и 11-02.

## Варианты и альтернативы

| Вариант | Решение |
|---|---|
| Один ряд `close` | отвергнут: прячет внутридневной провал ([ADR-006](../decisions/adr-006-forecast-semantics.md)) |
| Порядок внутри дня настраивается | отвергнут: один журнал давал бы разные минимумы по режимам |
| Дерево отрезков для ползунка | не делаем: полный пересчёт `O(N + M)` (design-brief §1, C23) |
| Старт от якоря и явный `as_of` | выбрано |

У других (проверенные факты на страницах tools): [PocketSmith](../tools/pocketsmith.md) стартует прогноз от фактического баланса и сверяет его ежедневными флагами разницы факта и плана, узкую точку ищут глазами; [Actual Budget](../tools/actual-budget.md) — экспериментальный отчёт Balance Forecast: стартовый остаток плюс симуляция вхождений расписаний, по дням или месяцам; самой низкой точки в docs отчёта не найдено; [hledger](../tools/plain-text-accounting.md) начинает `--forecast` после последней обычной транзакции, поэтому будущая запись сдвигает старт ([ADR-003](../decisions/adr-003-civil-dates.md)); [Float](../tools/business-cashflow-tools.md) показывает самую низкую точку окна и берёт по строке большее из бюджета и факта, у нас — сопоставление и остаток плана; [Firefly III](../tools/firefly-iii.md) прогноз исключил по заявлению автора. Цепочки причин с контрфактами в изученных материалах не найдены (2026-10-04; вывод).

### Не в v1

Режим `expected` (v2, лаг по истории потока, [ALG-13](alg-13-plan-vs-actual-calibration.md)); сценарные чипы `fx_shock`, `hours` (v1.1); пути Монте-Карло поверх `project` ([ALG-10](alg-10-uncertainty-monte-carlo.md), v2); внутридневной режим `intraday` — не планируется.

## Реализация в прототипе

Статус — **реализовано**: модуль `prototype/engine/timeline.mjs` (зависит от `money`, `dates`, `recurrence`, `hourly`, `fx`, `tax`, `debt`, `calibration`; единый расчёт `analyze(ws, query)` — в `prototype/engine/index.mjs`, см. [ALG-04](alg-04-can-i-afford.md)). Сверка с кодом и прогон тест-векторов TV1–TV6 — 2026-10-04: числа сходятся (ряды `plan`/`worse` G-001, Q1 и `runway_days`, G-001-gap, сценарии TV4, малые случаи TV6; объяснение TV5 — доли 4147 / 2765 / 2304 bp, накопленная 9217, контрфакты 273000 / 243000 / 233000 / 205500). Сводная таблица сигнатур — [canon-decisions](../../_ops/canon-decisions.md), «Финальные сигнатуры». Реальные сигнатуры:

```js
opening_state(ws, as_of, scenario?) -> {opening_minor, drift, anchor_age, stale_accounts: [{account_id, age}]}   // C-010, C-034
plan_from(ws, account | account_id, as_of) -> EpochDay                                                             // C-004
eff_date(e, mode, params, as_of) -> EpochDay | null                                                                // C-005
build_events(ws, query) -> CashEvent[]          // query = {as_of, horizon_end | horizon_days, mode?, scenario? | scenario_id?}
build_events_ex(ws, query) -> {events, allocations, warnings}       // + налоговые аллокации (ALG-06) и предупреждения W_*
apply_scenario(events, scenario, ctx) -> CashEvent[]               // ctx = {as_of, horizon_end, calendars, default_account_id, default_currency?, decision_currency?}
purchase_to_events(purchase, account_id, scenario_id?) -> CashEvent[]                                              // C-008
project(events, opening_minor, as_of, horizon_end) -> {from, opening_minor, close, trough}
argmin_first(xs, lo, hi) -> int;   narrowest_point(series, a, b) -> {date, amount_minor}
answer_q1(series, D, B) -> Q1Answer | {beyond_horizon: true}
runway_days(series, events) -> {with, without}                                                                     // C-005, C-006
explain_narrowest(events, series, params) -> {point, peak, out_total_minor, inflow_offset_minor, chain, counterfactuals}   // C-007
outflow_90(ws, as_of) -> Minor | null;  buffer_hint(ws, as_of) -> Minor | null;  default_wave_threshold(ws, as_of) -> Minor   // C-022
```

Сверх страницы в модуле: `normalize_ws`, `flat_params`, `get_param`, `normalize_mode`, `TIMELINE_DEFAULTS`, `scenario_fx_shock`; экспорты, принадлежащие другим темам, — `anchor_status` ([ALG-13](alg-13-plan-vs-actual-calibration.md)), `rule_statuses` ([ALG-06](alg-06-tax-envelope.md)), `active_operating_currencies` ([ALG-08](alg-08-fx-conversion.md)) и `readiness` (D-23).

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Реализовано целиком всё, что страница относит к v1, и часть v1.1 и v2. Что изменилось в `timeline.mjs` с 2026-10-05 (все изменения аддитивны, ряды G-001 и замок вывода движка прежние): умолчания §2.0 читаются из `vocab.json` через `vocab.generated.mjs` (FP-17, REQ-019), литералов в модуле нет; верхний предел горизонта `HORIZON_DAYS_MAX = 3660` — `horizon_days` и `horizon_end` дальше предела дают `E_SCHEMA` (`horizon_days_out_of_range`, `horizon_end_out_of_range`; К-4, Q-12); идентификаторы из чужого файла (`__proto__`, `constructor`) — обычные ключи данных (`own_put`, Q-07); одиночная нога перевода больше не исключается молча (Q-01, К-15): расход остаётся в ряде, а `build_events_ex` добавляет служебное предупреждение `W_TRANSFER_UNPAIRED` (пара operating + operating по-прежнему внутренний перевод); явный нулевой остаток счёта в чужой валюте курса не требует (Q-16, `zero_or_decision`); платежи по долгу за горизонтом в ряд не входят, но считаются и дают `W_DEBT_BEYOND_HORIZON` (FP-14: `debt_id`, число и сумма платежей). Служебные коды вне `vocab.json` живут в `engine/warnings_ext.mjs` (К-39). Рядом с ядром (надстройки, из `index.mjs` не реэкспортируются): `validate_ws.mjs` (проверка рабочей области и журнала до расчёта, карантин записей `analyze_checked`, пределы размеров и диапазоны параметров — REQ-017, REQ-158), `scenario_ext.mjs` (операция сценария `hours{stream_id, minutes}` — переводится в обычные `set_amount` над событиями потока; ядро `apply_scenario` на `hours` по-прежнему отвечает `E_SCHEMA op_not_in_v1`), `expected.mjs` (ряд «ожидаемый» как отображаемая оценка поверх готового `Analysis`; режим `expected` в расчёте по-прежнему `E_SCHEMA mode_not_in_v1`). В демо расчёт модели набора, «Купить» и списков волн идёт через `analyze` в Web Worker с откатом на главный поток (FP-21, `calc_async.mjs`), число дней горизонта в шапке, на «Запасе хода», листе для печати и в «Настройках» одно и то же (`horizon_ahead_of`, FP-48), «Почему» узкой точки с номером расчёта и контрфактами (`why_more.mjs`, FP-07, FP-47). **Не реализовано:** режим `expected` как режим расчёта (D-04), пути Монте-Карло внутри `project` ([ALG-10](alg-10-uncertainty-monte-carlo.md)), `intraday`; сценарная операция `hours` в сохраняемом сценарии набора (живёт только через `scenario_ext`).

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; номера TST — по [стратегии тестирования](../product/11-testing-strategy.md); в скобках число тестов файла):

| Файл | Что покрывает |
|---|---|
| `prototype/tests/timeline.test.mjs` (39) | `project` (TV6 день 0, нет событий, `N = 1`, ошибки), `argmin_first`, `answer_q1`, `runway_days`, `eff_date`, `apply_scenario`, `purchase_to_events`, `opening_state`, `build_events` (окно от якоря C-004, статусы, переводы, валюты, график долга), `explain_narrowest`, `outflow_90`; TST-01, 31 (сохранение, 10³ случаев), 33 (часть), 34 (локальность), 35 (монотонность), 36 (аддитивность), 41 (TV6: `expected` → `overdue`), 53 (оракулы A–C), 54 (`N·M = 180·10³`), 57 |
| `prototype/tests/g001.test.mjs` (22), `prototype/tests/g001.golden.test.mjs` (10) | TST-01 (все 58 дней обоих режимов, Q1, `runway_days`), TST-07 (объяснение `worse` и `plan`), TST-09 (G-001-gap), TST-36 (TV4 на G-001), TST-41, TST-57; G-001-low и G-001-late; golden-набор ключей §9.4–§9.9 |
| `prototype/tests/analyze.test.mjs` (18) | `analyze` как потребитель рядов: `query`, режимы, сценарий (встроенный и по `scenario_id`), Q1 на `D`; TST-33 (детерминизм, `inputs_hash`) |
| `prototype/tests/adversarial/semantics.test.mjs` (177, из них 2 `todo`), `prototype/tests/adversarial/golden_properties.test.mjs` (76) | состязательные: сохранение и локальность `project`, `eff_date`, `apply_scenario` (ошибки, `add_flow`), объяснение (свойства на случайных рядах), оракул сценариев, окно сопоставления ±3 дня; оба `todo` файла `semantics` — не про ALG-02 (ALG-03 инв. 3 и ALG-09 инв. 3); часть тестов этих файлов помечена номерами TST, которых нет в стратегии для этой темы (например, объяснение — «TST-32» вместо TST-07) |
| `prototype/tests/hardening.test.mjs` (40, один пропущен), `prototype/tests/validate_ws.test.mjs` (23) | закрытие пунктов `todo` этой страницы (п. 11 — Q-01, `W_TRANSFER_UNPAIRED`; п. 12 — Q-16, явный нулевой остаток), пределы горизонта и параметров (К-4, Q-12), проверка рабочей области и карантин записей (FP-02, FP-22) |
| `prototype/tests/properties.test.mjs` (13), `properties_mutation.test.mjs` (10), `engine_lock.test.mjs` (12), `small_journals.test.mjs` (11) | FP-24: инварианты TST-31, 33, 34, 35, 36, 39 на 1000 журналах общего генератора и их красный результат на подменах функций движка; замок вывода `analyze` на 500 журналах (`tests/engine.lock.json`, TST-52); пустой журнал, одно событие, дубли дат, ±(2⁵³−1) |
| `prototype/tests/scenario_builder.test.mjs` (19), `expected.test.mjs` (6), `calc_async*.test.mjs` | операция `hours` через `scenario_ext`, ряд «ожидаемый», расчёт через Worker с откатом на главный поток (FP-07, FP-11, FP-21) |

**Расхождения «псевдокод ≠ код»** (смысл совпадает; при сверке 2026-10-04 код не менялся, изменения после неё — в абзаце «Состояние на 2026-10-27» выше):

1. `query` и `ws`. Код принимает `{as_of, horizon_end | horizon_days, mode?, scenario? | scenario_id?}`: `horizon_end` главнее `horizon_days`, иначе `params.horizon_days`, иначе 180; `mode` по умолчанию `plan`, `conservative` = `worse`, `expected` → `E_SCHEMA`; встроенный `scenario` главнее `scenario_id`, неизвестный `scenario_id` — `E_SCHEMA`; даты — `IsoDate` или `EpochDay`. `ws` — словари «id → запись», массивы или `Map`, алиасы (`planned_one_offs` = `plans`, `fx` = `rates`) и проекции журнала `js.*`; `params` — плоские ключи `a.b` (`'worse.income_delay_days'`) с умолчаниями §2.0 (`TIMELINE_DEFAULTS`) или вложенные объекты; всё приводит `normalize_ws`.
2. Шаг 1 `build_events`: потоки часов — `expand_stream_ex(s, window, cal, {rounding, as_of})`, возвращает события и предупреждения (`W_HOURS_NOT_CONFIRMED`); график долгов (`schedule_to_events`) добавлен в псевдокод страницей выше.
3. `build_events` возвращает `CashEvent[]`; `build_events_ex` — ещё `allocations` (`allocations_for_events(events, tax_rules, as_of)`, ALG-06) и `warnings` (`W_RULE_STALE`, `W_RULE_DISABLED`, `W_HOURS_NOT_CONFIRMED`; из расширений — `W_TRANSFER_UNPAIRED` и `W_DEBT_BEYOND_HORIZON`, их коды вне `vocab.json`); резерв не в валюте решения — `E_CURRENCY_MISMATCH`.
4. Шаги 4–5 в коде слиты в `fx.to_decision_events`: отдельной `drop_internal_transfers` нет. Фильтр operating и исключение внутренних переводов выполняются там же; `external_transfer_ids` — переводы разовых записей, у которых есть нога не на operating-счёте (в том числе за окном или горизонтом): operating-нога такого перевода остаётся расходом/доходом; неизвестный счёт — `E_SCHEMA`, валюта события ≠ валюте счёта — `E_CURRENCY_MISMATCH`.
5. `opening_state(ws, as_of, scenario?)`: третий аргумент — сценарий, его `fx_shock` пересчитывает остатки счетов (остаток и поток сценария — по одному курсу); `E_FUTURE_POSTED` бросается для `posted` любого счёта (в псевдокоде — только для operating-счетов; таблица граничных случаев счёт не ограничивает); крипта на operating-счёте — `E_SCHEMA`.
6. `apply_scenario`: ссылка — `event_ref` или `ref`; `ctx` дополнительно несёт `default_currency` и `decision_currency` (валюта покупки — `op.currency ?? default_currency ?? decision_currency`); `add_purchase` допускает короткую форму `{date, amount_minor}`; id — `'scn:' + scenario_id + ':' + n` (встроенный сценарий без id — `scn:inline:n`); `delay_income` и `shift_flow` сдвигают и `plan_date`, если оно уже есть; `set_amount` с нулём — `E_SCHEMA`. Операция `fx_shock` **реализована раньше, чем на странице** («Не в v1»: v1.1): данных не меняет, курс применяют `build_events_ex` и `opening_state`; `hours` в ядре → `E_SCHEMA` (`op_not_in_v1`), а через надстройку `scenario_ext.mjs` (FP-07, REQ-051) работает: она заранее переводит `hours` в обычные `set_amount` над событиями потока.
7. `purchase_to_events`: пустой `parts` или часть ≤ 0 — `E_SCHEMA`; в событие добавлено `is_exceptional: false`.
8. `answer_q1`: `B = null` считается нулём (предупреждение `W_BUFFER_UNSET` строит `analyze`); `D` — `IsoDate` или `EpochDay`.
9. `explain_narrowest`: доли — `mul_div(…, 10000, out_total, 'half_even')`, режим округления зашит (не `params.rounding`); при `half_even` значения те же, что у `round_div` страницы.
10. `outflow_90` исключает любые ноги с `transfer_id`, ноги обмена (`fx`), платежи привязанного налогового резерва (`kind = tax`) и `is_exceptional`; `buffer_hint` и `default_wave_threshold` читают `buffer_hint_days` и `rounding` из `flat_params(ws.params)`.
11. **Закрыто (FP-02, Q-01, К-15), было `todo` TST-27 (D-07):** одинокая нога перевода без парной (данные неполны) больше не исключается молча. Расход остаётся в ряде как внешний перевод, `build_events_ex` добавляет служебное предупреждение `W_TRANSFER_UNPAIRED` (`transfer_id`); пара из двух ног на operating-счетах по-прежнему внутренний перевод, обе ноги исключены (числа G-001 не меняются). Тест — `hardening` (названия «TST-27 Q-01 …»); код предупреждения вне `vocab.json` (К-39), текст RU/EN — в `engine/warnings_ext.mjs`.
12. **Закрыто (FP-02, Q-16), было `todo` TST-27 (D-20):** явный нулевой остаток operating-счёта в чужой валюте курса не требует (`zero_or_decision`; тот же контракт у `fx.opening_in_decision`). Счёт без якоря и без фактов в чужой валюте остаток не задаёт вовсе и по-прежнему требует курс (`E_NO_RATE`) — это закреплённый тестом `timeline` сигнал неполных данных, а не расхождение. Тест — `hardening` («TST-27 Q-16 …»).

## Связанные страницы

- [ALG-01: развёртка правил повторения](alg-01-recurrence-expansion.md) — источник плановых вхождений
- [ALG-13: сопоставление план↔факт](alg-13-plan-vs-actual-calibration.md) — статусы, якорь, свежесть
- [ALG-03: волны](alg-03-payment-waves-detection.md), [ALG-04: Q3](alg-04-can-i-afford.md), [ALG-11: safe-to-spend](alg-11-safe-to-spend.md) — потребители рядов
- [ADR-006](../decisions/adr-006-forecast-semantics.md), [прогноз денежного потока](../concepts/cash-flow-forecast.md), [требования](../product/02-requirements.md), [глоссарий](../product/14-glossary.md)
