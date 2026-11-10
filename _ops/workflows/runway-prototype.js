export const meta = {
  name: 'runway-prototype',
  description: 'Прототип движка Runway (чистый JS, без зависимостей) по канону design-brief: слои L0–L3, демо, состязательные тестеры, исправления, сверка кода с вики',
  phases: [
    { title: 'L0-core', detail: 'money, dates, recurrence, ledger, vocab, тестовая оснастка' },
    { title: 'L1-leaf', detail: 'fx/tax/hourly/debt/sinking ∥ io/calibration (сопоставление)' },
    { title: 'L2-engine', detail: 'timeline + G-001 датасет → waves + afford + фасад analyze' },
    { title: 'L3-top', detail: 'montecarlo+backtest ∥ tools+verifier+cli ∥ demo UI' },
    { title: 'Adversarial', detail: '4 состязательных тестера ищут баги и ошибки канона' },
    { title: 'Fix', detail: 'исправление найденного, полный прогон тестов' },
    { title: 'Reconcile', detail: 'сверка псевдокода ALG-страниц с кодом, 15-prototype-guide' },
  ],
}

const ROOT = 'C:\\xampp\\htdocs\\01\\301\\runway'
const P = ROOT + '\\prototype'
const W = ROOT + '\\wiki'

const COMMON = [
  'Ты — инженер проекта «Runway»: исполняемый ПРОТОТИП детерминированного движка прогноза денежного потока (чистый JavaScript, ES modules, БЕЗ зависимостей, Node 24, тесты — node --test). Сегодня 2026-10-04. Рабочая папка: ' + ROOT + '; код — ' + P + '. Пиши комментарии и сообщения тестов по-русски; идентификаторы — snake_case как в каноне.',
  '',
  'КАНОН (читай ПЕРЕД работой; ему нельзя противоречить):',
  '  1. ' + ROOT + '\\_ops\\design-brief.md (v1.1, ≈190 КБ, читай частями offset/limit): §2 определения D-01…D-23 и словарь §2.0, §3 модель данных, §4 соглашения псевдокода, §5 КАРТА МОДУЛЕЙ, §7.4 таблица TST, §8 срез v1, §9 СКВОЗНОЙ ПРИМЕР G-001 и независимые векторы (ожидаемые числа тестов), §10 запрещённые формулировки, §12 решения координатора, §13 журнал изменений v1.1 (98 решений C-001…C-098), §14 РЕШЕНИЯ БЛОКЕРОВ АУДИТА (B1–B4, N5–N10) — §14 имеет наивысший приоритет. ТАКЖЕ ЧИТАЙ ' + ROOT + '\\_ops\\canon-decisions.md (раздел «Финальные сигнатуры экспортов» — ИМЕНА, АРГУМЕНТЫ И ПОРЯДОК АРГУМЕНТОВ пиши ДОСЛОВНО по нему; он главнее таблицы §5 brief) и ' + ROOT + '\\_ops\\signature-audit.md (список расхождений, уже исправленных в страницах). Актуальный список тестов TST-01…TST-60 — в ' + W + '\\product\\11-testing-strategy.md (используй его ID в названиях тестов).',
  '  2. ' + W + '\\decisions\\adr-001…016 — те, что относятся к твоим модулям (минимум ADR-001 ядро JS, 002 деньги, 003 даты, 004 журнал, 014 тестирование).',
  '  3. Страницы алгоритмов ' + W + '\\algorithms\\alg-NN-*.md: их пишут параллельно документаторы; если страница твоего ALG уже есть — это ПОДРОБНАЯ спецификация (псевдокод, граничные случаи, тест-векторы): реализуй по ней. Если страницы нет — по design-brief + ADR + ' + W + '\\ideas\\proposal-engine.md. При расхождении страницы и design-brief приоритет у design-brief; расхождение — в spec_issues отчёта.',
  '',
  'ПРАВИЛА КОДА',
  '- Движок (prototype/engine/*.mjs) ЧИСТЫЙ: никаких Date, Date.now, Math.random, fetch, process, require/import node:fs/node:crypto/node:path внутри engine/ (порты — аргументы). Зависимости только между модулями по правилу из §5 по правилу design-brief §14 B4: money ← dates ← {recurrence,hourly,fx,tax,debt,calibration} ← timeline ← sinking ← {waves,afford} ← index(analyze) ← {tools ← verifier, backtest}; montecarlo — от timeline,sinking,afford,calibration; ledger — только money; calibration — только money/dates (БЕЗ timeline/index); io — ledger,dates,money; backtest.mjs — НОВЫЙ модуль (backtest, release_gate, default_breach), зависит от index,afford,ledger,calibration.',
  '- Деньги — целые (Number в безопасном диапазоне; BigInt только в mul_div/конвертации с проверкой assert_minor), НИКАКИХ float для денег. Даты — EpochDay (целое), на диске/в тексте YYYY-MM-DD; без часовых поясов.',
  '- Каждая публичная функция — JSDoc с типами; имена экспортов и сигнатуры — как в §5 design-brief. Чистые функции, детерминизм, без скрытого состояния.',
  '- Тесты — node:test + node:assert/strict в prototype/tests/<имя>.test.mjs. В названии теста указывай ID: test("TST-16 …", …) для тестов из таблицы §7.4 (один тест может покрывать несколько TST — перечисли). Ожидаемые числа берутся из §9 (G-001 и независимые векторы) ДОСЛОВНО.',
  '- Если число из канона НЕ воспроизводится: сначала найди ошибку в своей реализации и перепроверь арифметику вручную; если уверен, что ошибка в каноне — оставь тест с ожидаемым значением канона в test.todo/skip с пояснением «расхождение с каноном» и опиши в spec_issues (ничего не подгоняй под код молча).',
  '- Пиши ТОЛЬКО файлы своей зоны (перечислены в задании). Не правь файлы других модулей и wiki/*, raw/*, data/*, tools/*, _ops/*. Если нужно изменить чужой модуль — опиши в notes, не правь.',
  '- Перед возвратом: запусти node --test в ' + P + ' (весь набор) — свои тесты должны быть зелёными, регрессии чужих — в notes. Верни честные числа (tests_total/tests_pass), без округления в пользу себя.',
  '',
  'Отчёт верни по схеме; файлы должны быть записаны до отчёта.',
].join('\n')

const SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' }, description: 'созданные/изменённые файлы' },
    tests_total: { type: 'integer' },
    tests_pass: { type: 'integer' },
    tst_covered: { type: 'array', items: { type: 'string' }, description: 'TST-ID, покрытые тестами' },
    spec_issues: { type: 'array', items: { type: 'string' }, description: 'расхождения/ошибки канона, найденные при реализации' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'tests_total', 'tests_pass', 'spec_issues'],
}

// Повтор при сбое (сеть/API): agent() возвращает null после терминальной ошибки.
// Первая попытка сохраняет исходный label (кэш resume), повторы — с суффиксом.
async function ag(prompt, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await agent(prompt, attempt === 1 ? opts : { ...opts, label: opts.label + '#' + attempt })
    if (r) return r
    log('Нет результата у ' + opts.label + ' (попытка ' + attempt + '/3)' + (attempt < 3 ? ' — повтор' : ' — сдаёмся'))
  }
  return null
}

const run = (label, phaseName, task, effort) =>
  ag([COMMON, '', '=== ТВОЁ ЗАДАНИЕ: ' + task.title + ' ===', task.body].join('\n'),
    { label, phase: phaseName, schema: SCHEMA, effort: effort || 'high' })

// ============ L0: ядро ============
phase('L0-core')
const l0 = await run('l0:core', 'L0-core', {
  title: 'ядро: money, dates, recurrence, ledger, vocab + тестовая оснастка',
  body: [
    'Зона записи: ' + P + '\\package.json ({"type":"module","scripts":{"test":"node --test"}}), ' + P + '\\README.md (кратко: что это, как запускать, карта модулей), ' + P + '\\engine\\{vocab.json,money.mjs,dates.mjs,recurrence.mjs,ledger.mjs}, ' + P + '\\tests\\{helpers.mjs,money.test.mjs,dates.test.mjs,recurrence.test.mjs,ledger.test.mjs,purity.test.mjs,arith.test.mjs}, ' + P + '\\tests\\arith.lock.json.',
    'Реализуй ВСЕ экспорты money.mjs, dates.mjs, recurrence.mjs, ledger.mjs из design-brief §5 (включая чистую реализацию sha256 без node:crypto; в тесте сверь её с node:crypto — в ТЕСТЕ импорт node:crypto допустим). vocab.json — словарь §2.0 (значения по умолчанию, вердикты, режимы, статусы, подписи RU/EN). dates: days_from_civil/civil_from_days (Hinnant), календари выходных/праздников, n-й и последний рабочий день, shift_by_policy. recurrence: validate_rule, nominal_dates, occ_key, effective_date, expand_rule/expand_all (конец месяца без дрейфа, exdates, interval, until/count, override по occ_key). money: округление half_even/half_up, floor/ceil div, mul_div на BigInt выше 2^53, split_equal, split_largest_remainder, parse_minor/format_minor (ru/en, без Intl). ledger: canon (канонический JSON), sha256, inputs_hash/state_hash, make_event/reduce/effective_events/upcast, dedup_key, state_at.',
    'Тесты: TST-11…19, часть TST-51 (фаззинг дат 1970–2100, 29 февраля, суммы 0/±1/±(2^53−1)), TST-52 (arith.lock: корпус входов→выходов арифметики money в tests/arith.lock.json и тест, который падает при любом изменении результата), TST-33 (детерминизм inputs_hash), purity.test.mjs (сканирует engine/*.mjs на запрещённые API: Date, Math.random, fetch, node:*, process — падает при находке). Фаззинг — с детерминированным ГПСЧ внутри ТЕСТОВ (seed фиксирован).',
  ].join('\n'),
})
log('L0: ' + (l0 ? l0.tests_pass + '/' + l0.tests_total : 'НЕТ РЕЗУЛЬТАТА'))
if (!l0) return { error: 'L0 не получился — прототип остановлен', layers: { l0 } }

// ============ L1: листовые модули ============
phase('L1-leaf')
const [l1a, l1b] = await parallel([
  () => run('l1:leaf-modules', 'L1-leaf', {
    title: 'листовые модули: fx, tax, hourly, debt, sinking',
    body: [
      'Зона записи: ' + P + '\\engine\\{fx,tax,hourly,debt,sinking}.mjs и ' + P + '\\tests\\{fx,tax,hourly,debt,sinking}.test.mjs. Модули money/dates/recurrence/ledger уже готовы (L0) — используй их, не правь.',
      'Реализуй ВСЕ экспорты этих модулей из §5 design-brief (v2-функции debt.reanchor/prepay — тоже, если есть спецификация; иначе пометь TODO и сообщи). Тесты: TST-20…30 (sinking: страховка 5×120,00, отпуск с догоном и пул, режим fixed/недостача; налог: аллокация/округление, версии правил, release/true_up; часы: брутто/переработка, недоработка; FX: перевод, −5%, выведенный курс, крипта сатоши→EUR; долг: аннуитет, график, последний платёж; рассрочка). Решения X3 (sinking n=0/rem≤0), X4 (резерв в валюте решения по spot на дату поступления) — из design-brief §12. sinking.reserve_series и free_series — по D-07/D-08 и ADR-016.',
    ].join('\n'),
  }),
  () => run('l1:io-calibration', 'L1-leaf', {
    title: 'io (CSV/JSON/hledger) и calibration (сопоставление план↔факт, малые выборки)',
    body: [
      'Зона записи: ' + P + '\\engine\\{io,calibration}.mjs и ' + P + '\\tests\\{io,calibration}.test.mjs. Модули money/dates/recurrence/ledger готовы (L0). Из calibration реализуй ВСЕ низкоуровневые экспорты по canon-decisions.md «Финальные сигнатуры» и design-brief §14 B4 (calibration зависит ТОЛЬКО от money/dates; backtest/release_gate/default_breach в calibration НЕ входят — они в отдельном модуле backtest.mjs, его пишет другой агент): match_plan_to_fact, classify_occurrence, assign_statuses, lag_observations, shrink_to_prior, ewma, wilson, dev_class, flow_key, flow_calibration, unlogged_rate, stale_status. Из io: parse_csv (RFC 4180, разделители ; , \\t, кавычки, BOM), parse_with_profile, dry_run, export_json/import_json (round-trip с state_hash), export_csv, csv_safe_cell (решение X5: экранировать только текстовые колонки), export_hledger (периодические транзакции + разовые; формат hledger), import_hledger — v1.1: реализуй подмножество, если успеешь, иначе пометь TODO. Если в окружении есть бинарь hledger (проверь child_process в ТЕСТЕ, не в engine!) — сверь экспорт с hledger (TST-44), иначе тест-skip с пояснением. Тесты: TST-19 (часть), 32, 38, 40, 42, 43, 44, 50 (часть: сжатие к prior).',
    ].join('\n'),
  }),
])
log('L1: leaf ' + (l1a ? l1a.tests_pass + '/' + l1a.tests_total : '—') + ', io/cal ' + (l1b ? l1b.tests_pass + '/' + l1b.tests_total : '—'))
if (!l1a || !l1b) return { error: 'L1 не получился после повторов — остановлено', layers: { l0, l1a, l1b } }

// ============ L2: движок ============
phase('L2-engine')
const l2a = await run('l2:timeline', 'L2-engine', {
  title: 'timeline.mjs и датасет G-001',
  body: [
    'Зона записи: ' + P + '\\engine\\timeline.mjs, ' + P + '\\data\\g001.json (+ варианты g001-low.json, g001-gap.json по §9.9), ' + P + '\\tests\\{timeline,g001}.test.mjs, ' + P + '\\tests\\oracle.mjs (МЕДЛЕННАЯ независимая реализация проекции для сверки — наивный пересчёт по дням, без кэшей, пишется отдельно от timeline.mjs, импортирует только money/dates).',
    'Реализуй все экспорты timeline.mjs по canon-decisions.md «Финальные сигнатуры» (в т.ч. readiness(ws, as_of) — design-brief §14 B3; purchase_to_events живёт в timeline, не в afford; apply_scenario(events, scenario, ctx); часы вызывай с opts={rounding: ws.params.rounding} — §14 B2; налоговые аллокации — allocations_for_events(events, rules, as_of) — §14 B1): opening_state, build_events (правила, потоки по часам, налоговые аллокации, рассрочки, гипотезы; режим; валюта решения — через fx), eff_date (plan/worse, просроченный доход по D-04/D-06), project (close/trough, «расходы раньше доходов»), narrowest_point, answer_q1, runway_days, apply_scenario, explain_narrowest (цепочка и контрфакты по D-?? / §9.8). Датасет G-001 «Ян» (§9.1) закодируй в JSON СТРОГО по модели данных §3; ВАЖНО: горизонт примера — horizon_days = 57 (§12 X2). Тесты: TST-01, 02 (резервы/free — используя sinking.reserve_series/free_series из L1), 07, 09, 10 (часы+налог на G-001), 31 (сохранение), 34 (локальность правки), 35 (часть: worse ≤ plan), 36 (аддитивность дельта-сценариев), 41 (expected→overdue), 53 (оракул vs быстрая реализация на 10^4 случайных наборов, seed фиксирован), 54 (производительность N=10^3 событий, H=180 — порог из ADR-014), 57 (готовность данных/свежесть якоря).',
  ].join('\n'),
})
log('L2a timeline: ' + (l2a ? l2a.tests_pass + '/' + l2a.tests_total : 'НЕТ РЕЗУЛЬТАТА'))
if (!l2a) return { error: 'L2a (timeline) не получился — остановлено', layers: { l0, l1a, l1b, l2a } }

const l2b = await run('l2:waves-afford', 'L2-engine', {
  title: 'waves.mjs, afford.mjs и фасад index.mjs (analyze)',
  body: [
    'Зона записи: ' + P + '\\engine\\{waves,afford,index}.mjs, ' + P + '\\tests\\{waves,afford,analyze}.test.mjs. timeline.mjs, sinking.mjs и датасеты ' + P + '\\data\\g001*.json уже готовы — используй, не правь.',
    'Реализуй все экспорты waves.mjs и afford.mjs из §5 (detect_waves жадная кластеризация g=3/S=10/θ по X1, apply_wave_overrides split/merge/pin, wave_metrics need_w=R_w+B/gap_w/coverage, list_waves; suffix_min, purchase_to_events, check_purchase (вердикты OK/TIGHT/FRAGILE/NO, plan+worse), max_amount, earliest_date (бинарный поиск), safe_to_spend, default_sts_horizon). Фасад index.mjs: analyze(ws, query) → Analysis по design-brief §3.9 (C-012), состав query — §14 B3: {as_of, horizon_days?, horizon_end?, scenario?, scenario_id?, D?, buffer_minor?, modes?}; реэкспорт публичного API; формат Analysis опиши в JSDoc. purchase_to_events — в timeline (используй оттуда). Тесты: TST-03, 04, 05, 06, 08 (G-001-low), 30 (часть: дробление покупки), 35 (часть: монотонность вердикта по S), 37 (разбиение обязательств волнами), 39 (S_max(as_of)=STS(horizon_end); без резервов free=trough), + тест-регрессия: все ключи G-001.* из §9.4–9.9 в одном golden-файле tests/g001.golden.test.mjs.',
  ].join('\n'),
})
log('L2b waves/afford: ' + (l2b ? l2b.tests_pass + '/' + l2b.tests_total : 'НЕТ РЕЗУЛЬТАТА'))
if (!l2b) return { error: 'L2b (waves/afford) не получился — остановлено', layers: { l0, l1a, l1b, l2a, l2b } }

// ============ L3: верхний уровень ============
phase('L3-top')
const [l3a, l3b, l3c] = await parallel([
  () => run('l3:montecarlo', 'L3-top', {
    title: 'montecarlo.mjs и НОВЫЙ модуль backtest.mjs',
    body: [
      'Зона записи: ' + P + '\\engine\\montecarlo.mjs, НОВЫЙ ' + P + '\\engine\\backtest.mjs (backtest, release_gate, default_breach — design-brief §14 B4; calibration.mjs НЕ править), ' + P + '\\tests\\{montecarlo,backtest}.test.mjs, ' + P + '\\data\\synthetic-journals\\ (генератор синтетических журналов — детерминированный). Реализуй mix32, u01, make_seed, sample_lag, run_paths (общие случайные числа между вариантами, воспроизводимость по seed), nearest_rank, p_fail (+ Уилсон из calibration) по ADR-008/ALG-10 и §9.15; backtest(journal,t0,h,opts)->{n_origins,hidden,mae_minor,coverage,frr,cry_wolf,...} по canon-decisions.md/ALG-13 (C-055: пробой буфера в течение 30 дн. после покупки, REQ-176/185), release_gate, default_breach. Тесты: TST-48, 49, 50, 55, 60 (гейт релиза на СИНТЕТИЧЕСКИХ журналах: FRR ≤ 5 %, cry-wolf ≤ 50 % — это прототипная демонстрация метрики, реальных журналов нет; так и пиши в комментарии).',
    ].join('\n'),
  }),
  () => run('l3:tools-verifier', 'L3-top', {
    title: 'tools.mjs, verifier.mjs, CLI и линтер словаря/обещаний',
    body: [
      'Зона записи: ' + P + '\\engine\\{tools,verifier}.mjs, расширение ' + P + '\\engine\\index.mjs (только добавление экспортов tools/verifier — осторожно, файл создан другим агентом), ' + P + '\\cli.mjs (node cli.mjs data/g001.json check-purchase 2026-10-12 30000 EUR — печатает ответ шаблоном A0 с evidence), ' + P + '\\tests\\{tools,verifier,injection}.test.mjs, ' + ROOT + '\\tools\\lint_vocab.mjs (линтер словаря и обещаний: сканирует wiki/**/*.md и prototype/demo на запрещённые формулировки design-brief §10 и недопустимые вердикты вне §2.0; вывод как у lint.mjs; игнорирует блоки, где формулировка приведена как запрещённая — таблицы §10-подобные и цитаты в «Нельзя»). Реализуй TOOLS (10 инструментов §5.1 с JSON-схемами), validate_args (мини-валидатор), run_tool, make_evidence, call_id; extract_quantities, verify_answer, render_answer, templates (RU/EN, плюральные формы), fallback_answer — по ADR-010/013 и ALG-12. Тесты: TST-45 (V1–V14), 46 (prompt injection: недоверенный текст в описаниях транзакций не попадает в контекст; права T0/T1; ссылки), 47 (конверт evidence/call_id), 56 (линтер словаря и обещаний запускается тестом на фикстурах и на реальных wiki-страницах — на реальных только как отчёт, не как падение).',
    ].join('\n'),
  }),
  () => run('l3:demo-ui', 'L3-top', {
    title: 'демо-интерфейс (одна страница, без зависимостей)',
    body: [
      'Зона записи: ' + P + '\\demo\\{index.html,app.mjs,style.css,i18n.mjs} и ' + P + '\\serve.mjs (мини-сервер статики на node:http, порт 8787, корень — prototype/). Движок: ' + P + '\\engine\\index.mjs (analyze) и датасеты ' + P + '\\data\\g001*.json — читай их API, не правь. Открывается через http://localhost/01/301/runway/prototype/demo/ (XAMPP) или node serve.mjs. Требования: адаптивная одностраничка, тёмная/светлая тема (prefers-color-scheme), RU/EN переключатель, без внешних зависимостей и CDN.',
      'Экраны/блоки (см. wiki/product/03-ux-screens.md, если уже есть, иначе по design-brief и ideas/proposal-product.md): (1) «Обзор» — SVG-график остатка (close и trough) с отметкой узкой точки, закрашенными окнами волн, линией буфера, «швом сегодня»; рядом таблица значений (доступность для скринридера); (2) «Могу ли я это купить?» — поля сумма/дата (+ ползунки) → ТРИ ответа: вердикт (OK/TIGHT/FRAGILE/NO с подписями RU/EN), максимум S_max и самая ранняя дата, для режимов plan и worse; блок «почему» (цепочка виновников и контрфакты); (3) «Волны» — карточки волн: нужно/дефицит физический/покрытие; (4) «Резервы» — налоговый конверт и sinking, свободный остаток free, STS; (5) «Сценарии» — чипы «клиент платит на N дней позже», «покупка»; (6) «Лента» — прошлое+будущее с «швом сегодня»; (7) «Ассистент A0» — поле ввода команды («можно ли купить за 300 € 12 октября»), разбор простыми правилами → вызов инструмента движка → шаблонный ответ + чип «числа из расчёта c_…» (БЕЗ LLM); (8) загрузка/выгрузка JSON состояния, переключатель датасетов G-001 / low / gap. Тон текстов — design-brief §10 (никаких «спокойно», «без галлюцинаций»; оговорка про налоги «расчёт по введённым правилам, не консультация» там, где есть налоговый конверт). Тесты для UI: tests/demo.test.mjs — статическая проверка (все импорты разрешаются, i18n-ключи RU/EN совпадают, нет запрещённых слов); браузерный рендер можешь проверить вручную через встроенный браузер, если доступен (mcp__Claude_Browser__*; запусти node serve.mjs в фоне и останови после), но это необязательно.',
    ].join('\n'),
  }),
])
log('L3: mc ' + (l3a ? l3a.tests_pass + '/' + l3a.tests_total : '—') + ', tools ' + (l3b ? l3b.tests_pass + '/' + l3b.tests_total : '—') + ', demo ' + (l3c ? l3c.tests_pass + '/' + l3c.tests_total : '—'))

// ============ Adversarial ============
phase('Adversarial')
const TESTER_SCHEMA = {
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          module: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          description: { type: 'string' },
          repro: { type: 'string', description: 'файл теста и/или код воспроизведения' },
          expected: { type: 'string' },
          actual: { type: 'string' },
        },
        required: ['id', 'module', 'severity', 'description', 'repro'],
      },
    },
    canon_suspects: { type: 'array', items: { type: 'string' }, description: 'подозрения на ошибки в каноне (design-brief/ADR/ALG), а не в коде' },
    tests_written: { type: 'integer' },
    summary: { type: 'string' },
  },
  required: ['bugs', 'canon_suspects', 'tests_written', 'summary'],
}
const TESTER_COMMON = [
  COMMON,
  '',
  '=== РОЛЬ: СОСТЯЗАТЕЛЬНЫЙ ТЕСТЕР ===',
  'Код движка написан другими агентами и «зелёный» по их собственным тестам. Твоя задача — СЛОМАТЬ его: найти реальные баги и расхождения с каноном. Пиши НОВЫЕ тесты в ' + P + '\\tests\\adversarial\\<твоё_имя>.test.mjs (не правь engine/ и чужие тесты!). Тест, который падает из-за настоящего бага, ОСТАВЛЯЙ падающим (это улика) и описывай в bugs; тесты, которые проходят, — тоже полезны (регрессии). Не подгоняй ожидания под код: ожидаемые значения выводи из канона (§2–§9, §12) и независимого расчёта. Если канон сам противоречив — это canon_suspects, не баг кода.',
  'В отчёте: tests_written — сколько тестов написано; bugs — только ПОДТВЕРЖДЁННЫЕ воспроизводимые баги (с repro). Запусти свои тесты: node --test tests/adversarial/<файл>.',
].join('\n')

const adv = await parallel([
  () => ag(TESTER_COMMON + '\n\nЛИНЗА A — ДАТЫ, ПОВТОРЕНИЯ, ДЕНЬГИ: dates.mjs, recurrence.mjs, money.mjs, ledger.mjs. Ищи: дрейф конца месяца, 29 февраля/високосные века (1900, 2000, 2100), переходы между годами, interval>1 с «якорем» месяца, count/until на границах, exdates и override, праздники, отрицательные/нулевые суммы, округление ничьих, split_largest_remainder при нулевых/отрицательных весах и сумме 0, mul_div на границе 2^53, parse_minor с мусором/пробелами/разными разделителями, format↔parse round-trip на случайных входах, canon() с порядком ключей/юникодом, sha256 на пустом/длинном вводе, upcast/reduce идемпотентность. Имя файла: dates_money.', { label: 'adv:dates-money', phase: 'Adversarial', schema: TESTER_SCHEMA, effort: 'high' }),
  () => ag(TESTER_COMMON + '\n\nЛИНЗА B — ЧИСЛА КАНОНА И ОРАКУЛ: независимо перепроверь golden-числа G-001 (§9.4–§9.9) — пересчитай их своим отдельным наивным кодом (в тесте, без импорта timeline.mjs/afford.mjs) и сравни и с каноном, и с выводом движка; найди расхождения канона с кодом И канона с самим собой. Затем property-based/фаззинг на случайных датасетах (детерминированный ГПСЧ в тесте): сохранение close по дням, worse ≤ plan, free ≤ trough, S_max(as_of)=STS(horizon_end), earliest_date монотонна по S, check_purchase монотонна по сумме, перестановка событий не меняет результат, добавление/удаление нулевого события не меняет результат. Имя файла: golden_properties.', { label: 'adv:golden-properties', phase: 'Adversarial', schema: TESTER_SCHEMA, effort: 'high' }),
  () => ag(TESTER_COMMON + '\n\nЛИНЗА C — СЕМАНТИКА Q1/Q2/Q3, РЕЗЕРВЫ, ВАЛЮТЫ, ЧАСЫ: waves.mjs, afford.mjs, timeline.mjs (в части сценариев/explain), sinking.mjs, tax.mjs, hourly.mjs, fx.mjs, debt.mjs. Ищи: события в день as_of/horizon_end, пустые ряды, нулевой буфер, отрицательный старт, несколько валют и крипта (liquidity_bp=0), курс отсутствует/устарел, налоговая аллокация при смене версии правила, sinking с n=0/rem≤0 (§12 X3), перевод в копилку при резерве (X12), волны на границах g/S/θ (X1), просроченный доход (overdue) и режим worse, недоработка часов, переработка, лаг выплаты через конец месяца, аннуитет с нулевой ставкой и последним платежом, рассрочка на n=1, explain: сумма вкладов цепочки = величина пика. Имя файла: semantics.', { label: 'adv:semantics', phase: 'Adversarial', schema: TESTER_SCHEMA, effort: 'high' }),
  () => ag(TESTER_COMMON + '\n\nЛИНЗА D — ВЕРИФИКАТОР, ИНСТРУМЕНТЫ, ИНЪЕКЦИИ, IO: tools.mjs, verifier.mjs, io.mjs, calibration.mjs, montecarlo.mjs. Ищи: числа в тексте ответа в разных форматах (1 234,56 / 1,234.56 / €7 600 / 7.6k / −470 / 470 с минусом-тире), даты в разных форматах, подмена величин одинаковой цифры разной семантики (дефицит 470,00 vs баланс −470,00), ответы без чисел, лишние числа, округление, RU/EN плюрали; инъекции в описаниях транзакций/заметках («игнорируй инструкции», поддельные evidence/call_id, разметка), аргументы вне схемы/слишком большие/неверные типы, превышение лимита вызовов; CSV: BOM, кавычки с переводами строк, разные разделители, формулы-инъекции (=,+,-,@) только в текстовых колонках, дубли и «возможные двойники», идемпотентность повторного импорта; export→import round-trip state_hash; Монте-Карло: воспроизводимость, общие случайные числа, nearest_rank на малых n, Уилсон на k=0/k=n. Имя файла: verifier_io.', { label: 'adv:verifier-io', phase: 'Adversarial', schema: TESTER_SCHEMA, effort: 'high' }),
])
const reports = adv.filter(Boolean)
const allBugs = reports.flatMap((r) => r.bugs || [])
const suspects = reports.flatMap((r) => r.canon_suspects || [])
log('Тестеры: ' + reports.length + '/4; багов ' + allBugs.length + '; подозрений на канон ' + suspects.length)

// ============ Fix ============
phase('Fix')
const fix = await ag(
  [
    COMMON, '',
    '=== РОЛЬ: ИСПРАВИТЕЛЬ ===',
    'Четыре состязательных тестера нашли баги (JSON ниже). Тесты-улики лежат в ' + P + '\\tests\\adversarial\\. Твоя задача: (1) для каждого бага — подтвердить воспроизведение, найти причину, исправить КОД в prototype/engine/ (минимально и в духе канона), не ослабляя тест; (2) если тестер ошибся (ожидание неверно по канону) — поправь ТЕСТ и объясни в notes; (3) подозрения на ошибки канона НЕ исправляй в коде молча: если код следует канону, оставь как есть и перенеси в spec_issues; (4) в конце запусти ВЕСЬ набор node --test в prototype/ и добейся зелёного (допустимы только явные test.todo/skip с пояснением «расхождение с каноном»). Верни честные tests_total/tests_pass и список исправленного.',
    '',
    'БАГИ:', JSON.stringify(allBugs, null, 1),
    '',
    'ПОДОЗРЕНИЯ НА ОШИБКИ КАНОНА:', JSON.stringify(suspects, null, 1),
    '',
    'Зона записи: prototype/engine/*.mjs, prototype/tests/**, prototype/demo/* (если баг в UI). Не правь wiki/*, raw/*, data/*, _ops/*.',
  ].join('\n'),
  { label: 'fix', phase: 'Fix', schema: SCHEMA, effort: 'high' }
)
log('Fix: ' + (fix ? fix.tests_pass + '/' + fix.tests_total : 'НЕТ РЕЗУЛЬТАТА'))

// ============ Reconcile ============
phase('Reconcile')
const RECON_COMMON = [
  'Ты — редактор-сверщик проекта «Runway». Сегодня 2026-10-04. Рабочая папка ' + ROOT + '. Прототип движка готов: ' + P + '\\engine\\*.mjs (+ tests, demo). Вики-страницы алгоритмов: ' + W + '\\algorithms\\alg-NN-*.md описывают алгоритмы псевдокодом и содержат раздел «Реализация в прототипе» со статусом «планируется».',
  'ЗАДАЧА: для каждой страницы твоей группы (1) сопоставь псевдокод страницы с реальным кодом модуля: выпиши расхождения (имена, порядок аргументов, граничные случаи, формулы); (2) обнови раздел «Реализация в прототипе»: модуль, реальные сигнатуры экспортов, перечень тестов (TST-ID и файлы), статус «реализовано / частично / нет» и честный список расхождений «псевдокод ≠ код» (если расхождение — баг кода, а не страницы, не правь код: перечисли в отчёте поле code_issues; если расхождение — неточность страницы, исправь страницу МИНИМАЛЬНО, не ломая канон); (3) проверь цифры тест-векторов страницы: прогони соответствующую функцию (node -e с импортом из prototype/engine/index.mjs) и убедись, что числа сходятся; расхождения исправь в странице или перечисли в отчёте.',
  'Правки — только в своих страницах wiki/algorithms/ (и, если указано, product/15-prototype-guide.md). Не правь код, design-brief, ADR, requirements, glossary. После правок запусти node ' + ROOT + '\\tools\\lint.mjs (ошибки ссылок на ещё не созданные страницы допустимы).',
].join('\n')
const RECON_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    mismatches_fixed: { type: 'array', items: { type: 'string' } },
    code_issues: { type: 'array', items: { type: 'string' }, description: 'расхождения, где неправ код (не страница)' },
    vector_failures: { type: 'array', items: { type: 'string' }, description: 'тест-векторы страниц, которые не сошлись' },
  },
  required: ['files', 'mismatches_fixed', 'code_issues', 'vector_failures'],
}
const recon = await parallel([
  () => ag(RECON_COMMON + '\n\nТВОЯ ГРУППА: ALG-01, ALG-02, ALG-03, ALG-04, ALG-11 (' + W + '\\algorithms\\).', { label: 'recon:alg-core', phase: 'Reconcile', schema: RECON_SCHEMA }),
  () => ag(RECON_COMMON + '\n\nТВОЯ ГРУППА: ALG-05, ALG-06, ALG-07, ALG-08, ALG-09 (' + W + '\\algorithms\\).', { label: 'recon:alg-money', phase: 'Reconcile', schema: RECON_SCHEMA }),
  () => ag(RECON_COMMON + '\n\nТВОЯ ГРУППА: ALG-10, ALG-12, ALG-13, ALG-14 (' + W + '\\algorithms\\). Учти design-brief §14 B4: backtest/release_gate/default_breach реализованы в НОВОМ модуле backtest.mjs (не в calibration.mjs) — исправь в ALG-13 раздел «Реализация в прототипе» и упоминания модуля. Дополнительно СОЗДАЙ страницу ' + W + '\\product\\15-prototype-guide.md (type: product, frontmatter по CLAUDE.md): руководство по прототипу — как запустить (node --test, node serve.mjs, XAMPP URL), структура папок, карта модулей↔ALG↔TST, как читать тесты, как добавить сценарий, ограничения прототипа (чего нет: UI-хранилище, синхронизация, LLM), честный отчёт «что реализовано относительно среза v1 §8», ссылки на страницы вики. Реальные числа возьми из запуска: node --test (всего тестов/зелёных/skip).', { label: 'recon:alg-top+guide', phase: 'Reconcile', schema: RECON_SCHEMA }),
])
const okRecon = recon.filter(Boolean)

return {
  layers: { l0, l1a, l1b, l2a, l2b, l3a, l3b, l3c },
  adversarial: { reports: reports.map((r) => ({ tests: r.tests_written, bugs: (r.bugs || []).length, summary: r.summary })), bugs: allBugs, canon_suspects: suspects },
  fix,
  reconcile: okRecon,
}
