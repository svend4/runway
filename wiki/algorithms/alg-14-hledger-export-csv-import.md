---
title: "ALG-14: импорт CSV и экспорт в hledger"
type: algorithm
status: reviewed
summary: "Профили CSV как данные, нормализация, ключ дедупликации sha256, сухой прогон, откат партии и экспорт в hledger-журнал, JSON и CSV; псевдокод, векторы на G-001, оракул hledger."
sources: [wiki/ideas/proposal-architecture.md, wiki/ideas/proposal-product.md, wiki/ideas/red-team-critique.md, wiki/decisions/adr-011-manual-entry-csv-hledger-import.md, wiki/tools/ynab.md, wiki/tools/actual-budget.md, wiki/tools/firefly-iii.md, wiki/tools/plain-text-accounting.md, wiki/tools/pocketsmith.md, wiki/tools/budget-guru.md]
updated: 2026-10-27
---

# ALG-14 Импорт CSV и экспорт в hledger

## Назначение

Ручной ввод — осознанный выбор целевого пользователя ([ADR-011](../decisions/adr-011-manual-entry-csv-hledger-import.md)), но выписки банков и переезд из таблиц нужны. Алгоритм даёт повторяемый вход (CSV по профилю-данным, сухой прогон, идемпотентность, откат партии) и выход без привязки к продукту (JSON, CSV, hledger-журнал — он же независимый оракул движка). Блок «ввод/вывод»; свежие факты питают Q1 ([ALG-13](alg-13-plan-vs-actual-calibration.md)).

Реализует REQ-091…REQ-096, REQ-173 (оракул), REQ-099 (v1.1) — [требования](../product/02-requirements.md); идеи IDEA-65, IDEA-84, IDEA-85, IDEA-56 ([предложение по архитектуре](../ideas/proposal-architecture.md)); определения — C21 в `_ops/design-brief.md`; журнал — [ADR-004](../decisions/adr-004-event-journal-projections.md). Риск — RISK-17 ([риски](../product/12-risks.md)).

## Определения

- **`ImportProfile`** (§3.9) — JSON-данные: `encoding`, `delimiter`, `skip`, `date{col, fmt}`, `amount{mode: signed|debit_credit, col | debit, credit, decimal, thousands}`, `currency{fixed | col}`, `desc{cols[]}`, `rules[{match, tag}]`; `delimiter` — только `,`, `;` или TAB. Для встроенного профиля `runway-csv/1` (C-045) допустимы ещё `profile_id`, `v`, `amount.unit: minor` (сумма — целое minor units), `desc.csv_safe` (снять ведущий `'`) и `filter{col, equals}` (строки планов отсеиваются). Исполняемых полей нет. `skip` — число строк преамбулы перед заголовком; следующая строка — заголовок, он обязателен; `col` — его имя или индекс с 0. Колонки внешнего идентификатора в v1 нет (FITID — v2; id банка можно подмешать в `desc.cols`); в `debit_credit` знак внутри колонки — `reject sign_in_debit_credit` (C-044). Профиль хранится записью журнала `profile.set` (C-069).
- **Кандидат** — разобранная строка `{row, account_id, date, amount_minor, currency, desc, tag, k, dedup_key}`; отклонённая — `{row, reason}`.
- **`norm(s)`**: NFKC → нижний регистр → каждая последовательность не-букв и не-цифр (`\p{L}`, `\p{N}`; комбинирующие знаки `\p{M}` сохраняются) → один пробел → `trim`. Диакритика сохраняется.
- **`dedup_key = hex(sha256(acc|date|amount_minor|currency|norm(desc)|k))[0:16]`**; `k` — номер среди одинаковых `(date, amount, currency, norm(desc))` в партии в порядке строк.
- **Сухой прогон**: `recognized + rejected + duplicates = rows_total`. **Возможный двойник** — новая строка, у которой есть запись той же суммы в окне `±match.window_days` без совпавшего ключа.
- **Партия** — `import.started` + `tx.posted` с `actor = import:<batch_id>`; откат — `revert` каждой записи.

## Входы и выходы

| Вход | Тип | Смысл |
|---|---|---|
| `profile` | `ImportProfile` | данные разбора |
| `text` | string | файл, уже декодированный; ≤ 5 МБ |
| `ctx` | `{account_id, account_currency, as_of}` | счёт назначения; нужен для ключа и проверки валюты |
| `existing_keys`, `existing_events` | `Set<string>`, `LedgerEvent[]` | **эффективные** (не откатанные, `effective_events`, C-070) записи |
| `state`, `as_of`, `horizon_end`, `opts` | | для экспорта; `opts = {history, rules, planned}`; `export_json` принимает журнал, не `State` |

| Выход | Тип |
|---|---|
| `parse_with_profile` | `{candidates[], rejects[{row, reason}], rows_total}` |
| `dry_run` | `{recognized, rejected, duplicates, rows_total, doubles[], from, to, overlap_days, gap_days}` |
| `export_json`, `export_csv`, `export_hledger` | string |

## Алгоритм

```pseudo
dedup_key(acc, date, amount_minor, currency, desc, k):
  если '|' ∈ acc или '|' ∈ currency: fail(E_SCHEMA)
  return hex(sha256(utf8(acc + '|' + format_date(date) + '|' + str(amount_minor) + '|' + currency + '|' + norm(desc) + '|' + str(k))))[0:16]

parse_csv(text, {delimiter}):                      # RFC 4180 с допусками → string[][]
  срезать BOM U+FEFF;  in_q = false;  field = '';  row = [];  rows = []
  для ch в text:
    если in_q:  ch == '"' ? (следующий символ '"' ? добавить '"' и пропустить его : in_q = false) : field += ch
    elif ch == '"' и field == '': in_q = true
    elif ch == delimiter: row += field;  field = ''
    elif ch ∈ {LF, CR}: (CRLF — один разрыв) row += field;  rows += row;  row = [];  field = ''
    else: field += ch
  если in_q: fail(E_SCHEMA, 'unterminated_quote')
  добавить хвост (row + field), если не пуст;  return rows без строк, где все поля == ''

parse_date_fmt(s, fmt):                            # токены YYYY (4 цифры), MM/DD (2), M/D (1–2), прочее — литерал
  не совпало или остался хвост → null;  m ∉ 1..12 или d ∉ 1..days_in_month(y, m) → null;  return days_from_civil(y, m, d)

parse_amount_cell(s, a, exp):                      # int | null
  s = trim(s), U+2212 → '-', убрать NBSP/U+202F;  a.thousands ≠ '' → удалить его вхождения
  try parse_minor(s, {decimal: a.decimal, thousands: '', exponent: exp}) catch → null     # пусто, мусор, знаков > exp

rule_matches(rule, nd):  m = rule.match;  anchored = m начинается с '^';  p = norm(anchored ? m[1:] : m)
  return p ≠ '' и (anchored ? nd начинается с p : p ⊂ nd)           # литералы, без regex: профиль — данные, без ReDoS

parse_with_profile(profile, text, ctx):
  v = validate_profile(profile);  не v.ok → fail(E_SCHEMA)       # validate_profile возвращает {ok, errors[{field, reason}]}: неизвестное поле, функция, шаблон — ошибка
  len(text) > 5·2^20 → fail(E_SCHEMA, 'file_too_large')
  rows = parse_csv(text, {delimiter: profile.delimiter})[profile.skip ..];  header = rows[0];  data = rows[1..]
  seen = {};  candidates = [];  rejects = []
  для r в data (row_no = skip + 2 + индекс в data — порядковый номер записи файла с 1):
    len(r) < нужных колонок → reject 'short_row';  profile.filter и r[filter.col] ≠ filter.equals → reject 'filtered_out'
    d = parse_date_fmt(r[date.col], date.fmt);  d == null → 'bad_date';  d > ctx.as_of → 'future_date'
    cur = currency.fixed ?? upper(trim(r[currency.col]));  не в реестре → 'unknown_currency';  cur ≠ ctx.account_currency → 'currency_mismatch'
    exp = currency_exponent(cur)
    если mode == signed:  v = (unit == minor) ? целое(r[amount.col]) : parse_amount_cell(r[amount.col], …);  null → 'bad_amount'
    иначе (debit_credit):
      x = trim(r[debit]);  y = trim(r[credit])
      оба пусты → 'empty_amount';  оба заполнены → 'both_debit_credit'
      s = непустая;  s начинается с '-' или '+' → 'sign_in_debit_credit'
      v = parse_amount_cell(s, …);  null → 'bad_amount';  v = (x ≠ '') ? −v : v
    v == 0 → 'zero_amount'
    desc = join(' ', непустые trim(r[c]) для c ∈ desc.cols, при desc.csv_safe — со снятым ведущим «'» перед формульным символом), без управляющих символов;  tag = tag первого подходящего правила (по норме desc) или null
    g = (d, v, cur, norm(desc));  k = seen[g] ?? 0;  seen[g] = k + 1
    candidates += [{row: row_no, account_id: ctx.account_id, date: d, amount_minor: v, currency: cur, desc, tag, k,
                    dedup_key: dedup_key(ctx.account_id, d, v, cur, desc, k)}]
  return {candidates, rejects, rows_total: len(data)}

dry_run(candidates, existing_keys, rejects = [], existing_events = [], params):
  recognized = [];  duplicates = [];  занято = {}
  для c в candidates:
    e = existing_events с e.dedup_key == c.dedup_key
    если c.dedup_key ∈ existing_keys и (e == null или e совпадает по date, amount, currency): duplicates += [c];  занято += e   # запись, объяснённая дубликатом, двойником не считается
    иначе: recognized += [c]                       # коллизия 64 бит с другими полями — не дубликат
  # занято: каждая существующая запись закрепляется не более чем за одним кандидатом — дубликатом или двойником
  для c в recognized по row:
    c.double = первая e ∈ existing_events (по date, event_id), e ∉ занято: тот же account_id, currency, amount_minor,
               |e.date − c.date| ≤ params.match.window_days;   если найдена — занято += e
  last = max(e.date для импортированных existing_events этого счёта);  from = min(c.date);  to = max(c.date)
  return {recognized: len(recognized), rejected: len(rejects), duplicates: len(duplicates), rows_total: len(candidates) + len(rejects),
          doubles: [c.row для c.double ≠ null], from, to,
          overlap_days: last ≠ null ? max(0, last − from + 1) : 0,  gap_days: last ≠ null ? max(0, from − last − 1) : 0}

import_commit(result, decisions, bytes, ctx):       # decisions[row] ∈ {accept, skip} для doubles; без решения — skip
  # ctx = {batch_id, profile_id?, next_id(), next_seq(), recorded_at} — порты: движок не читает часы и не создаёт идентификаторы
  batch_id = ctx.batch_id (uuidv7 создаёт адаптер);  source_hash = hex(sha256(bytes))
  evs = [make_event('import.started', {batch_id, profile_id, source_hash, counts}, ctx)]
  для c в recognized, не skip: evs += [make_event('tx.posted', {account_id, date, amount_minor, currency, tag, note: c.desc, dedup_key}, {actor: 'import:' + batch_id})]
  append_atomic(evs)                               # note — недоверенный текст (ADR-013)

import_rollback(batch_id, events, ctx):  append_atomic([revert(e) для эффективных e ∈ events с actor == 'import:' + batch_id] ++ [import.rolled_back{batch_id}])   # ctx — те же порты записи; откат уже откатанной партии ничего не добавляет; tx.voided в каноне нет: откат — только revert (C-070)
```

**Экспорт.**

```pseudo
csv_safe_cell(s):  s начинается с '=', '+', '-', '@', TAB или CR → "'" + s;  иначе s       # только текстовые колонки (X5)
export_csv(state, 'journal'):  разделитель ',', перевод строки LF; колонки date, account_id, amount_minor, currency, kind, layer, tag*, counterparty*, note*, event_id, dedup_key   # C-045
  # * — текстовые: csv_safe_cell, затем кавычки, если есть разделитель, '"', LF, CR ('"' → '""'); числа и даты — каноническое целое/ISO
  # встроенный профиль runway-csv/1 при импорте снимает ведущий "'" перед одним из = + - @ TAB CR (только для экспорта самого Runway)
export_json(journal):  canon({format: 'runway-journal/1', engine_version, events: полный журнал по порядку seq})      # принимает журнал (массив записей или {events}), не State: из состояния журнал не восстановить; engine_version — из аргумента, иначе 'unversioned'; seq обязателен (C-072); включает match.set (ручная привязка факта к плану, C-051)
  # round-trip: state_hash(import_json(export_json(j))) = state_hash(reduce(effective_events(j))), state_hash(state) = hex(sha256(canon(state))) — свёртка, recorded_at в неё не входит (C-071)

export_hledger(state, as_of, horizon_end, opts = {history: from_anchor, rules: materialize, planned}):
  out = ['; runway-journal/1 · as_of ' + format_date(as_of) + ' · horizon_end ' + format_date(horizon_end)]
  для ccy по коду: 'commodity ' + format_minor(1000·10^exp, exp, {decimal: '.', thousands: ''}) + ' ' + ccy
  для r ∈ rates по (date, fx_id): 'P ' + date + ' ' + base + ' ' + (num/den, ≤ 10 знаков, half_even) + ' ' + quote
  # 1. факты и якоря; bal[a] — баланс счёта в журнале hledger
  from_anchor: берётся последний якорь счёта ≤ as_of, проводки с date ≤ anchor.date опускаются (они в якоре, D-22);  full: все
  для a: bal[a] = 0;  хронология по (date; tx раньше anchor той же даты):
    tx → items += txn(tx);  bal[a] += amount
    anchor(A) → delta = A − bal[a];  items += anchor_txn(date, a, delta, A);  bal[a] = A
  # 2. план: planned, status ∈ {expected, overdue}, режим plan, eff_date ∈ [as_of, horizon_end], в валюте счёта;
  #    статусы — по свёртке с учётом match.set (C-051); окно плана счёта начинается с даты его последнего якоря (plan_from, C-004)
  #    io не разворачивает правила и потоки: плановые события приходят портом opts.planned (результат build_events в режиме plan; plan_from применяет он);
  #    здесь только фильтр expected/overdue, [as_of, horizon_end] и валюта счёта; без opts.planned — только разовые plan.set состояния, не закрытые фактом через plan_ref
  для e по (eff_date, event_id): items += '~ ' + format_date(eff_date) + '  ' + clean(name) + postings(e)       # разовое правило
  # opts.rules == native: правило, для которого native_expressible, — одной строкой '~ monthly from … to …' (не проверено на hledger)
  return out ++ items, перевод строки LF в конце
txn(e):    ДАТА ' * ' clean(desc);  posting 1: acct(a) + 2 пробела + amt(e.amount_minor);  posting 2: противосчёт + amt(−e.amount_minor)
  transfer: две ноги → одна транзакция;  разные валюты: нога продажи 'amt @@ amt получения'
anchor_txn(date, a, delta, A):  ДАТА ' * якорь';  posting 1: acct(a) + amt(delta) + ' = ' + amt(A);
  posting 2: ('equity:opening' для первой записи счёта, иначе 'equity:drift') + amt(−delta)      # assertion верна, дрейф виден
acct(a) = (kind == debt ? 'liabilities:' : 'assets:') + slug(a.name);  противосчёт: amount > 0 ? 'income:' : 'expenses:' + slug(tag ?? 'unsorted')
amt(m, a) = format_minor(m, a.exponent, {decimal: '.', thousands: ''}) + ' ' + a.currency        # 0 без знака
clean(s) = заменить управляющие символы и ';' на пробел, схлопнуть пробелы, trim, ≤ 200 символов, пусто → 'без описания'
native_expressible(rule) = freq == M, interval == 1, by_monthday ≤ 28, weekend == keep, без exdates, count, by_workday, Override
```

Решения. **Ключ без идентификатора банка**: в v1 CSV нет надёжного id; FITID (OFX, v2) заменит хэш. **`k` считается среди одинаковых**, поэтому два кофе за день различимы, а пересекающиеся выписки дают те же ключи. **Возможный двойник не сливается молча**: смена описания банком или ручная запись попадает в очередь подтверждения. **Литеральные правила меток** вместо regex (профиль — данные, ReDoS; C-044). **Якорь через `delta`**: транзакция `delta = A − баланс журнала` с `= A`-assertion и противосчётом `equity:opening` (первая запись счёта) или `equity:drift`; assertion остаётся истинной, а дрейф виден (D-22, C-046); `history: from_anchor` (по умолчанию) опускает проводки до последнего якоря. Расчёт и экспорт — по введённым данным, не консультация.

## Инварианты и свойства

1. Идемпотентность: повторный импорт файла даёт 0 новых записей (TST-32).
2. `recognized + rejected + duplicates = rows_total`; `dry_run` не меняет `state_hash`.
3. Ключи внутри партии уникальны; мультимножество ключей не зависит от порядка строк.
4. Детерминизм: `(profile, text, ctx)` → побайтно равные кандидаты.
5. Откат партии возвращает состояние (факты, ключи) к прежнему; `state_hash` совпадает с прежним, если не считать реестр `imports` (записи `import.started` и `import.rolled_back` эффективны и входят в свёртку, C-071); ключи откатанных записей не считаются существующими.
6. `state_hash(import_json(export_json(j))) = state_hash(reduce(effective_events(j)))` (TST-38).
7. В `export_csv` числовые колонки не изменяются; текстовые не начинаются с `= + - @ TAB CR`.
8. hledger: сумма постингов каждой транзакции по валюте равна 0 (кроме пары `@@`); `hledger bal assets:bank` на дату = `close` движка (TST-44).
9. Вывод `export_hledger` детерминирован.

## Сложность

Разбор `O(L)`; ключи `O(R)`; поиск двойников `O(R log E)` (индекс по счёту, валюте, сумме); экспорт `O(E log E)`. Файл ≤ 5 МБ, разбор в Worker.

## Граничные случаи

| Случай | Ожидаемое поведение | Почему |
|---|---|---|
| Файл > 5 МБ | `E_SCHEMA` до разбора | REQ-091 |
| Незакрытая кавычка | `E_SCHEMA`, ничего не импортируется | иначе сдвиг всех строк |
| Дата `31/02/2026` | reject `bad_date` | `days_in_month` |
| «12,345» при `exponent = 2` | reject `bad_amount`, без округления | деньги не теряются |
| Заполнены и дебет, и кредит | reject `both_debit_credit` | знак неизвестен |
| Валюта строки ≠ валюте счёта | reject `currency_mismatch` | две ноги — v1.1 |
| Два одинаковых платежа за день | `k = 0, 1`, ключи различны | не схлопываются |
| Повторный импорт файла | `duplicates = rows`, плашка «файл уже импортирован» (`source_hash`) | идемпотентность |
| Банк сменил описание | другой ключ → «возможный двойник» | не слияние молча |
| Окно выписки режет день посередине (две одинаковые операции, во втором файле видна только одна — с `k = 0`) | вторая из одинаковых операций в другом файле принимается за дубликат первой и теряется | известное ограничение `k`: честная граница, не скрывается (C-047; запись в [RISK-17](../product/12-risks.md)) |
| Описание с `=` или `;` | в журнале как есть; в CSV экранируется, в hledger `;` → пробел | X5; `;` начинает комментарий |
| Счёт без якоря | противосчёт `equity:opening` | баланс начинается с 0 |
| Профиль с неизвестным полем | `E_SCHEMA` | профиль — только данные |

## Тест-векторы

**TV-1. Ключи (§9.13).** `norm('MERCADONA  *1234 Valencia, ES') = 'mercadona 1234 valencia es'`; прообраз `acc_bank|2026-10-03|-4730|EUR|mercadona 1234 valencia es|0` → **`f78f01e9751c5f66`**. «Cafe Central» −450, `acc_bank`, 2026-10-03: `k = 0` → `9d82db80ee854a7c`, `k = 1` → `b9f6b8bb563b3b40`. Строка 2026-10-04, +123456, «Transferencia cliente», `k = 0` → `d371042d2b343ddb`. Коллизия при 10^5 записей ≈ 3·10^-10.

**TV-2. Профиль и сухой прогон.** Профиль: `;`, `skip = 0`, дата `DD/MM/YYYY`, `debit_credit` (`Cargo`, `Abono`), десятичный `,`, тысячи `.`, валюта EUR, `desc = [Concepto]`; `as_of = 2026-10-04`.

| Строка файла | Результат |
|---|---|
| `03/10/2026;MERCADONA  *1234 Valencia, ES;47,30;` | −4730, `k = 0`, `f78f…` — в `existing_keys` → дубликат |
| `03/10/2026;Cafe Central;4,50;` | −450, `k = 0` → дубликат |
| `03/10/2026;Cafe Central;4,50;` | −450, `k = 1`, `b9f6…` → распознано |
| `04/10/2026;Transferencia cliente;;1.234,56` | `parse_minor('1.234,56')` → +123456 → распознано |
| `31/02/2026;Error fecha;10,00;` | reject `bad_date` |
| `01/10/2026;Doble columna;5,00;5,00` | reject `both_debit_credit` |

Итог: распознано 2 · отклонено 2 · дубликатов 2; `2 + 2 + 2 = 6 = rows_total`; сумма распознанных `−450 + 123456 = 123006`. Повторный импорт после записи: распознано 0, дубликатов 4, отклонено 2.

**TV-3. Возможный двойник.** В журнале ручная запись `acc_bank`, 2026-10-02, −4730, EUR, без `dedup_key`. Кандидат `MERCADONA` (10-03, −4730): ключ нового нет, `|Δдата| = 1 ≤ 3`, сумма равна → `распознано` с флагом `double`, в запись попадёт только после `accept`. Второй кандидат той же суммы за 10-03 флаг не получит: запись закреплена за первым.

**TV-4. CSV и формулы.** `=HYPERLINK("http://x")` → `'=HYPERLINK("http://x")`; `-5 coffee` → `'-5 coffee`; колонка `amount_minor` со значением `-4730` не меняется; `runway-csv/1` при импорте восстанавливает текст.

**TV-5. G-001 → hledger (горизонт 57 дн., `plan`).** Счёт `acc_main` с именем `bank`, якорь 400000 на 2026-10-04:

```
; runway-journal/1 · as_of 2026-10-04 · horizon_end 2026-11-30
commodity 1000.00 EUR

2026-10-04 * якорь
    assets:bank  4000.00 EUR = 4000.00 EUR
    equity:opening  -4000.00 EUR

~ 2026-10-09  связь
    assets:bank  -25.00 EUR
    expenses:phone  25.00 EUR
~ 2026-11-05  почасовой доход
    assets:bank  2790.00 EUR
    income:hourly  -2790.00 EUR
```

Всего 16 разовых правил (8 продуктов, 2 связь, 2 аренда, 2 ЖКХ, налог, доход). Метки в примере латинские (`phone`, `hourly`) ради читаемости счетов; на данных `data/g001.json` метки русские, и тот же экспорт (плановые события берутся из `analyze(...).events.plan`) даёт `~ 2026-10-09  связь` с `expenses:связь` и `~ 2026-11-05  Почасовая работа` с `income:почасовая-работа` — число правил и суммы те же. Сверка: `hledger bal assets:bank --forecast=2026-10-04..2026-11-30 -e 2026-11-01` обязана дать `4000 − (25 + 100 + 100 + 500 + 100 + 900 + 120 + 100) = 2055,00 EUR` = `close[2026-10-31]` = 205500; с `-e 2026-12-01`: `2055 + 2790 − 400 − 25 − 1020 = 3400,00 EUR` = `end_close` 340000. Команда не запускалась, синтаксис периода не проверен (метка остаётся, C-042); без `--forecast` правила `~` не включаются, а интервал обязан начинаться с `as_of`, иначе планы на `as_of` теряются.

## Варианты и альтернативы

Плагины-импортёры в ядре и ключ без `k` отвергнуты ([ADR-011](../decisions/adr-011-manual-entry-csv-hledger-import.md)). У других (факты из `tools/`):

| Продукт | Импорт и дедупликация | Экспорт |
|---|---|---|
| [YNAB](../tools/ynab.md) | CSV-конвертер; `import_id` = сумма + дата + порядковый номер | CSV (план и регистр) |
| [Actual Budget](../tools/actual-budget.md) | CSV с маппингом, OFX/QFX; дедупликация по ID, дате, сумме, плательщику; импортированное приоритетнее ручного | в изученных материалах не проверялся |
| [Firefly III](../tools/firefly-iii.md) | отдельное приложение Data Importer (CSV, CAMT и др.) | CSV, который нельзя импортировать обратно |
| [PocketSmith](../tools/pocketsmith.md) | OFX/QFX/QIF/CSV | CSV/XLSX |
| [hledger](../tools/plain-text-accounting.md) | полуручной (CSV-правила, скрипты) | CSV, JSON, HTML |
| [Float](../tools/business-cashflow-tools.md) | чтение из Xero/QBO/FreeAgent | CSV/PDF |
| Budget Guru | заявлено в FAQ: импорт только руками ([разбор](../tools/budget-guru.md)) | self-service экспорт не проверялся (не подтверждено) |

### Не в v1

Импорт hledger-журнала (подмножество: `~` → `Rule`, `=` → `Anchor`, `P` → `FxRate`, `@`/`@@` → курс операции) и мастер таблиц (классы листов) — v1.1 (REQ-099, REQ-100); в прототипе `import_hledger` уже есть, мастера таблиц нет. Строки в чужой валюте с двумя ногами — v1.1. Адаптеры Дзен-мани/CoinKeeper, OFX с `FITID` приоритетнее хэша — v2 (REQ-101). Агрегаторы в ядре не делаем (REQ-102).

## Реализация в прототипе

**Статус: реализовано** — всё, что страница относит к v1: CSV по профилям-данным, нормализация и `dedup_key`, сухой прогон с «возможными двойниками», партия и откат, экспорт JSON / CSV / hledger, файл-копия; `import_hledger` (v1.1, подмножество) сделан досрочно. Из прежнего «Нет» к 2026-10-27 есть: **строки в чужой валюте с двумя ногами** (`engine/io_fx_rows.mjs`, FP-29, A14.7), **импорт часов CSV** (`engine/hours_io.mjs`, FP-29), **разбор файла в Worker** (`demo/import_worker.mjs`, FP-18, файлы от 128 КБ, с откатом на главный поток) и мастер импорта в демо (см. «Состояние на 2026-10-27» ниже). **Нет:** мастер таблиц (REQ-100, `.xlsx`), OFX с `FITID` и адаптеры Дзен-мани / CoinKeeper (v2, REQ-101, нет образцов выгрузок), периодические правила hledger `~` мастером не переносятся. **Оракул hledger не запускался:** бинаря `hledger` в среде нет, этот тест — один из двух пропусков в прогоне (`skipped 1` в `io.test.mjs`; второй — ночной фаззинг в `hardening`); независимая сверка выполнена вычислителем `mini_bal` внутри теста (2055,00 € на 2026-10-31 и 3400,00 € на конец горизонта), синтаксис периода `--forecast` по-прежнему не проверен на настоящем hledger (метка C-042 остаётся; скрипт `tools/hledger_oracle.mjs` печатает команды для Docker и ждёт среды, FP-40). Сверено с кодом и тестами 2026-10-04: числа TV-1…TV-5 пересчитаны вызовом функций — все сошлись; обновлено 2026-10-27 по сквозному прогону 2026-10-28 (194 файла, 3452 теста; [руководство по прототипу](../product/15-prototype-guide.md)).

Модули `prototype/engine/io.mjs` и `prototype/engine/ledger.mjs` (`dedup_key`, `norm`, `canon`, `sha256`, `reduce`, `effective_events`, `make_event`). Оба лежат в `engine/`: слои ADR-001 — правило зависимостей (design-brief §14 B4): `ledger` зависит только от `money`; `io` — от `ledger`, `dates`, `money` (от `timeline` — нет), а не отдельный каталог (C-095). `io.mjs` из `index.mjs` не реэкспортируется (`ledger` — реэкспортируется); с волны 1 демо использует `io.mjs` (экспорт JSON-копии журнала, CSV и hledger, мастер импорта CSV и hledger, файл-копия, открытие чужого файла), CLI — нет; прежняя выгрузка состояния `runway-state-<дата>.json` в `app.mjs` осталась рядом.

```js
// io.mjs
JOURNAL_FORMAT = 'runway-journal/1' ; MAX_IMPORT_BYTES = 5 * 1024 * 1024 ; RUNWAY_CSV_PROFILE      // встроенный профиль runway-csv/1 (данные)
detect_delimiter(text) -> ',' | ';' | '\t' ; parse_csv(text, { delimiter = ',' | ';' | '\t' | 'auto' }) -> string[][]
parse_date_fmt(s, fmt) -> EpochDay | null ; parse_amount_cell(s, a, exp) -> Minor | null ; rule_matches(rule, nd) -> bool
validate_profile(profile) -> { ok, errors: [{ field, reason }] }                                       // не бросает
parse_with_profile(profile, text, { account_id, account_currency, as_of }) -> { candidates, rejects, rows_total }
dry_run(candidates, existing_keys, rejects = [], existing_events = [], params = {}) -> { recognized, rejected, duplicates, rows_total, doubles: row[], from, to, overlap_days, gap_days, recognized_items[], duplicate_items[] }
existing_keys_of(state) -> Set<string>
import_commit(result, decisions, bytes, { batch_id, profile_id?, next_id, next_seq, recorded_at }) -> LedgerEvent[]
import_rollback(batch_id, events, { next_id, next_seq, recorded_at }) -> LedgerEvent[]
export_json(journal, { engine_version? }) -> string ; read_journal_json(text) -> { format, engine_version, events } ; import_json(text) -> State
csv_safe_cell(s) -> string ; export_csv(state, 'journal') -> string
export_hledger(state, as_of, horizon_end, { history?: 'from_anchor' | 'full', rules?: 'materialize' | 'native', planned? }) -> string
import_hledger(text, { recorded_at? }) -> State                                                         // v1.1, подмножество
// ledger.mjs
norm(s) -> string ; dedup_key(acc, date, amount_minor, cur, desc, k) -> hex16
```

**Состояние на 2026-10-27 (после волн 1, 2 и 3а; сверка с кодом, `prototype/README.md` и снимком движка от 2026-10-05).** Что изменилось в `io.mjs` и `ledger.mjs` (все изменения аддитивны, числа G-001 и замок вывода прежние): строгий разбор групп тысяч в `parse_amount_cell` — число с разделителем тысяч это группы ровно по три цифры, «12,50» при `thousands = ","` теперь `bad_amount`, а не 1250,00 (Q-05, К-32); идентификаторные колонки `account_id`, `currency`, `event_id`, `dedup_key` в `export_csv` защищены от формул так же, как текстовые (Q-10, К-33); профиль получил необязательные колонки `tag` и `counterparty` (REQ-095, FP-47: метка из колонки главнее правил по описанию, контрагент берётся по имени, ключ дедупликации от них не зависит; `account_id` и `kind` файл не читает); окно двойников `match.window_days` ограничено 0…31 (К-4, Q-12); `ledger.state_hash(state, {omit})` и `core_hash(state)` — хэш без реестра партий импорта (`imports`) до импорта и после отката равен (Q-21, К-31), `reduce(events, base, {own: true})` свёртывает «снимок + хвост» без копии. Рядом с ядром появились надстройки (из `index.mjs` не реэкспортируются): `engine/io_readonly.mjs` (FP-17: файл новее известного формата открывается «только для просмотра», `open_readonly` без апкаста и записи; `engine_version` в снимке журнала), `engine/validate_ws.mjs` (FP-02, FP-22: проверка чужого файла до расчёта, карантин записей — один плохой объект больше не отвергает файл целиком), `engine/io_fx_rows.mjs` и `engine/hours_io.mjs` (FP-29). Демо: мастер импорта CSV и hledger с сухим прогоном «распознано · отклонено · дубликатов» и откатом партии (`import_model.mjs`, `import_wizard.mjs`, FP-06), собственный CSV Runway (профиль `runway-csv-1` выбирается по заголовку и читает `amount_minor` как минимальные единицы — раньше мастер читал такую выгрузку как основные, и суммы выходили в 100 раз больше; сухой прогон теперь предупреждает об `minor_as_major` и `amount_scale`, FP-18; круг «экспорт → мастер» восстанавливает метку и контрагента), профили «часы» и «обмен» (`import_v11.mjs`, FP-29), разбор в Worker с откатом, экспорт JSON / CSV / hledger со списком потерь (`data_actions.mjs`, `FORMAT_LOSSES`), напоминание о копии и автозапись копии в выбранный файл (`backup.mjs`, `backup_file.mjs`, FP-05, FP-19), открытие чужого файла с карантином записей и режим «только чтение» (`open_quarantine.mjs`, `data_runtime.open_readonly`, FP-22, FP-17). **Не реализовано:** см. строку «Нет» в статусе выше; кроме того, CSV Runway не несёт сущностей контрагентов с идентификаторами (имя ↔ запись по справочнику), переводы CSV не переносит (для полной копии служит JSON), а полная проверка круга по `state_hash` с настоящим `hledger` не выполнялась. **Открытый `todo`:** буквальное равенство полного `state_hash` до импорта и после отката (К-31: записи `import.started` и `import.rolled_back` входят в свёртку; закрыто только по опции `omit`, `adversarial/verifier_io`, TST-32).

**Тесты** (все зелёные в сквозном прогоне 2026-10-28, `_ops/impl/run/verify-wave3a4-fp24-fix.txt`; запуск по одному файлу — `node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs` из `prototype/`; в скобках число тестов файла; [стратегия тестирования](../product/11-testing-strategy.md)):

| Файл | Что покрывает |
|---|---|
| `tests/io.test.mjs` (35, один пропущен) | TST-42 — TV-1 (ключи и `norm`); TST-43 ×11 — TV-2 (распознано 2 · отклонено 2 · дубликатов 2), TV-3 (двойник), TV-4 (формулы), причины отклонения, профиль как данные (неизвестные поля, функции и regex отвергаются), файл больше 5 МБ, CSV журнала, `runway-csv/1`; TST-32 ×2 — идемпотентность, откат партии; TST-38 ×3 — round-trip `export_json` → `import_json`; TST-44 ×8 — TV-5 (16 правил, шапка, якорь через `delta`), сверка 2055,00 € / 3400,00 €, фильтры плана, переводы и `@@`, безопасность вывода (`;`, управляющие символы), `rules: native`, оракул `hledger` (пропущен); TST-19 — разбор сумм профиля; TST-60 — `io` без `node:` и `Date`; round-trip `import_hledger` |
| `tests/ledger.test.mjs`, `tests/adversarial/dates_money.test.mjs` | `norm`, `dedup_key` (TST-42), `canon`, `state_hash` (TST-38) |
| `tests/hardening.test.mjs` (40, один пропущен), `tests/csv_roundtrip_fields.test.mjs` (16) | закрытие прежних `todo` этой страницы: Q-05 (группы тысяч), Q-10 (идентификаторные колонки), Q-21 (хэш после отката с опцией `omit` и `core_hash`); круг «экспорт → импорт» для метки и контрагента (REQ-095, FP-47) |
| `tests/import_model.test.mjs` (21), `import_wizard.test.mjs` (9), `import_runway_csv.test.mjs` (25), `import_runway_boot.test.mjs` (6), `import_worker.test.mjs` (18), `import_worker_model.test.mjs` (2), `import_main_thread.test.mjs` (10), `import_race.test.mjs` (8), `fp18_adv.test.mjs` (3) | мастер CSV и hledger, профиль `runway-csv-1` (экспорт Runway → мастер → те же факты, повтор даёт 0 новых), разбор файла в Worker побайтно равен синхронному, гонки перерисовки и ответа Worker, настоящий `app.mjs` на заглушке DOM (FP-06, FP-18) |
| `tests/io_fx_rows.test.mjs` (14), `hours_io.test.mjs` (14), `import_v11.test.mjs` (14), `import_v11_boot.test.mjs` (11) | строки в чужой валюте с двумя ногами как обмен (выведенный курс, `no_rate`), часы из CSV с откатом партии (FP-29) |
| `tests/readonly_open.test.mjs` (15), `engine_stamp.test.mjs` (15), `open_quarantine.test.mjs` (16), `backup.test.mjs` (8), `backup_file.test.mjs` (31), `data_actions.test.mjs` (33) | файл новее известного формата только для просмотра, версия движка в снимке, карантин записей чужого файла, копия и автозапись в файл (подделка `FileSystemFileHandle`), экспорт и «Удалить все данные» (FP-17, FP-22, FP-19, FP-05) |
| `tests/properties.test.mjs` (13), `tests/small_journals.test.mjs` (11), `tests/fuzz_nightly.test.mjs` (8) | FP-24: инварианты TST-32 и TST-38 (`state_hash(import_json(export_json(журнал)))` равен свёртке журнала; файл-копия канонична и не зависит от порядка записей на входе) на 1000 журналах общего генератора; малые журналы и ±(2⁵³−1); полный фаззинг `tools/fuzz_nightly.mjs --full` (10⁵ входов и 1 500 областей — 0 исключений, `../_ops/fuzz-nightly.json`) |
| `tests/adversarial/verifier_io.test.mjs`, разделы «IO: CSV» (21), «IO: JSON-копия» (5), «IO: CSV журнала» (6), «IO: hledger» (7), часть «ДОПОЛНЕНИЯ» | TST-43/51/42/32/40 — граничные случаи разбора, TST-38 — round-trip на 300 случайных журналах, TST-44, TST-54 — поиск двойников за `O(R log E)` |

**Псевдокод ≠ код** (результат сверки; «стр.» — исправлена страница, «код» — код оставлен как есть):

| № | Страница (до сверки) | Код | Решение |
|---|---|---|---|
| 1 | `norm`: только `\p{L}`, `\p{N}` | сохраняет и `\p{M}` (иначе «İSTANBUL» резался бы на «i stanbul», а деванагари — на отдельные буквы) | стр. |
| 2 | `validate_profile` — `fail(E_SCHEMA)` | возвращает `{ok, errors}`; `parse_with_profile` при `!ok` бросает `E_SCHEMA` | стр. |
| 3 | `import_commit`: `batch_id = uuidv7`; `import_rollback(batch_id, events)` | `batch_id`, `next_id`, `next_seq`, `recorded_at` — порты в `ctx`; откат принимает порты третьим аргументом | стр.; сигнатура `import_rollback` в каноне — без `ctx` |
| 4 | `export_json(state)`, «полный журнал по порядку `seq`» | `export_json(journal)`: из состояния журнал не восстановить; `engine_version` по умолчанию `'unversioned'`; `State` вместо журнала — `E_SCHEMA` | стр.; сигнатура в каноне — `export_json(state)` |
| 5 | `export_hledger` разворачивает план сам | плановые события — порт `opts.planned` (`io` не зависит от `recurrence`/`timeline`); фильтр `[as_of, horizon_end]`, `plan_from` применяет `build_events`; без порта — разовые `plan.set` | стр. |
| 6 | `io` зависит от `timeline` | не зависит (§14 B4) | стр. |
| 7 | инвариант 5: откат возвращает `state_hash` | состояние возвращается, кроме реестра `imports` (записи партии эффективны, C-071); с FP-02 (Q-21, К-31) равны `state_hash(state, {omit: ['imports']})` и `core_hash` до импорта и после отката, а полное буквальное равенство остаётся открытым `todo` | стр. |
| 8 | профиль без `profile_id`, `v`, `unit`, `csv_safe`, `filter`; причины отклонения без `filtered_out` | есть (нужны встроенному профилю `runway-csv/1`) | стр. |
| 9 | TV-5: метки `phone`, `hourly` | на данных G-001 метки русские: `expenses:связь`, `income:почасовая-работа` | стр. |
| 10 | `dry_run` — счётчики и `doubles` | плюс `recognized_items`, `duplicate_items`; запись, уже объяснённая дубликатом этого файла, свободной для двойника не считается (иначе второй кофе за день стал бы двойником первого) | стр.: псевдокод дополнен (`занято`); `recognized_items` и `duplicate_items` — дополнение кода |
| 11 | `import_hledger` — только в «Не в v1» | реализован: `commodity`, `P`, транзакции с одной или двумя активными ногами, `= A` → якорь, `~ ДАТА` → `plan.set`, `~ daily\|weekly\|monthly\|yearly\|every N …` → `Rule`; не поддержаны `@` (цена за единицу), автоматические транзакции, больше двух активных ног, `include` | дополнение кода |

**Известные пробелы.** Из трёх прежних пунктов этого раздела закрыты два (FP-02, волна 1): `parse_amount_cell` больше не удаляет все вхождения разделителя тысяч без проверки групп — при `thousands = ","` ячейка «12,50» отклоняется (`bad_amount`), а «1,234.50» и «1.234,50» читаются как прежде (Q-05); идентификаторные колонки (`account_id`, `event_id`, `currency`, `dedup_key`) в `export_csv` защищены от формул, и круг «экспорт → импорт» значения не меняет (Q-10). Остаётся один: буквальное равенство полного `state_hash` до импорта и после отката невозможно (строка 7 таблицы; тест `{todo}` «CANON?» в `tests/adversarial/verifier_io.test.mjs`, канон спорен сам с собой — C-070 / C-071 против ALG-14 инв. 5; решение за арбитром, FP-31).

## Связанные страницы

- [ADR-011 ручной ввод, CSV, hledger](../decisions/adr-011-manual-entry-csv-hledger-import.md), [ADR-004 журнал](../decisions/adr-004-event-journal-projections.md)
- [Импорт и экспорт (продукт)](../product/09-import-export.md), [ALG-13 сопоставление план↔факт](alg-13-plan-vs-actual-calibration.md), [ALG-02 проекция](alg-02-timeline-projection.md)
- [Plain-text accounting](../tools/plain-text-accounting.md), [YNAB](../tools/ynab.md), [Actual Budget](../tools/actual-budget.md), [Firefly III](../tools/firefly-iii.md)
