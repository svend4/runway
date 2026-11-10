export const meta = {
  name: 'runway-gap-analysis',
  description: 'Аудит «документация ↔ реализация»: 9 агентов по блокам требований + 5 тематических аудитов → синтез бэклога (wiki/product/18-implementation-gap-analysis.md, _ops/gap/backlog.json)',
  phases: [
    { title: 'Audit', detail: '14 параллельных аудиторов, только чтение кода; результат — _ops/gap/*.json|md' },
    { title: 'Synthesis', detail: 'сводная страница и приоритизированный бэклог с волнами реализации' },
  ],
}

const ROOT = 'C:\\xampp\\htdocs\\01\\301\\runway'
const W = ROOT + '\\wiki'
const OPS = ROOT + '\\_ops'
const GAP = OPS + '\\gap'
const P = ROOT + '\\prototype'
const REQ = W + '\\product\\02-requirements.md'

const COMMON = [
  'Ты — аудитор проекта «Runway»: LLM-вики (по паттерну Карпати) + исполняемый прототип движка прогноза денежного потока. Сегодня 2026-10-05. Рабочая папка: ' + ROOT + '. Пиши по-русски; идентификаторы и пути — как есть.',
  'Задача всей группы: честно ответить на вопрос владельца — «что есть в документации, но не реализовано в приложении, что можно дополнить и улучшить, ДОПИСЫВАЯ новые функции, не уменьшая существующий код». Ты проверяешь свою часть по КОДУ, а не по пересказам.',
  '',
  'ГДЕ ЧТО ЛЕЖИТ. Прототип: ' + P + ' — engine/*.mjs (19 модулей: money, dates, recurrence, ledger, fx, tax, hourly, debt, sinking, calibration, timeline, waves, afford, tools, verifier, io, montecarlo, backtest, index), demo/ (index.html, app.mjs ≈105 КБ, i18n.mjs, style.css — одностраничное демо с вкладками Обзор/Купить/Волны/Резервы/Сценарии/Лента/Ассистент/Данные, ассистент A0 на правилах, импорт/экспорт JSON, RU/EN, темы), cli.mjs, serve.mjs, data/ (g001*.json, synthetic-journals), tests/ (29 файлов; 1098 тестов; названия тестов содержат TST-NN и часто REQ-NNN). Итоги прототипа: ' + OPS + '\\workflow3-result.json и ' + W + '\\product\\16-prototype-findings.md; руководство ' + W + '\\product\\15-prototype-guide.md; карта TST: ' + OPS + '\\tst-coverage.json. Канон: ' + OPS + '\\design-brief.md (срез v1 в §8), ' + OPS + '\\canon-decisions.md.',
  'Известное про демо: лента «только для чтения: внесение фактов и сверка не включены»; данные живут только в памяти вкладки (закрытие сбрасывает); есть загрузка/выгрузка JSON; ввода операций/правил/часов в интерфейсе нет; нет PWA/офлайн-оболочки, нет IndexedDB, нет файла-копии с напоминанием; нет мастера CSV-импорта в UI; нет hledger-экспорта/удаления в UI; нет вероятностной полосы (Монте-Карло) на графике; нет очереди сверки план↔факт; нет настроек (буфер/горизонт/параметры) в UI.',
  '',
  'ПРАВИЛА',
  '- ТОЛЬКО ЧТЕНИЕ кода и вики. Не правь prototype/*, wiki/*, raw/*, data/*, tools/*, design-brief/canon-decisions. Пиши ТОЛЬКО свои файлы в ' + GAP + ' (папку создай, если нет).',
  '- Каждое утверждение «реализовано» подтверждай доказательством: путь файла + имя функции/теста (Grep по REQ-NNN, TST-NN, имени функции). «Реализовано» = есть код И тест/доказательство; «частично» = есть часть (укажи, чего нет); «нет» = не найдено (укажи, что искал); «не код» = процессное/бизнес/документационное требование, кода не требует.',
  '- Не выдумывай. Если сомневаешься — status partial и поясни, что проверить.',
  '- Предложения «что сделать» — конкретные и АДДИТИВНЫЕ (новые функции/файлы/экраны, не переписывание существующего); оценивай усилие S (≤ 0,5 дня) / M (1–2 дня) / L (3+ дня).',
  '- JSON-файл проверь: node -e "JSON.parse(require(\'fs\').readFileSync(\'<путь>\',\'utf8\'))".',
].join('\n')

const REQ_SCHEMA_NOTE = [
  'ФОРМАТ ФАЙЛА: массив объектов (по одному на КАЖДОЕ REQ-NNN твоего блока, без пропусков):',
  '{ "id": "REQ-001", "title": "короткое название", "priority": "Must|Should|Could|Won\'t", "phase": "v0|v1|v1.1|v2|—", "status": "implemented|partial|missing|not_code", "layer": "engine|ui|infra|process|docs", "evidence": "пути/функции/тесты (≤ 200 симв.)", "gap": "что НЕ реализовано (пусто для implemented)", "work": "конкретное аддитивное действие (пусто для implemented/not_code)", "effort": "S|M|L|" }',
  'Приоритет и фазу бери из блока REQ (строка «Приоритет и фаза»). Слой: engine — движок prototype/engine; ui — демо; infra — хранение/PWA/сеть/шифрование/сервер; process — процессы/бизнес/метрики/исследования; docs — документация.',
].join('\n')

const SECTIONS = [
  { key: 'core-data', title: 'Ядро: деньги, даты, повторы + Данные: журнал, слои, форматы', from: 39, to: 192 },
  { key: 'q1', title: 'Q1: «Хватит ли денег к дате?»', from: 193, to: 301 },
  { key: 'q2-q3', title: 'Q2: волны платежей + Q3: «Могу ли я это купить?», «можно потратить», сценарии', from: 302, to: 479 },
  { key: 'reserves-hours', title: 'Резервы, налоговый конверт, sinking funds + Доход по часам', from: 480, to: 625 },
  { key: 'fx-debt', title: 'Валюты и крипта + Долги и рассрочки', from: 626, to: 697 },
  { key: 'io', title: 'Ввод, импорт и экспорт', from: 698, to: 806 },
  { key: 'ui', title: 'Интерфейс и i18n', from: 807, to: 931 },
  { key: 'privacy-ai', title: 'Приватность и безопасность + AI-ассистент', from: 932, to: 1093 },
  { key: 'quality-ops', title: 'Надёжность и производительность + Доступность + Тестируемость + Операционные и бизнес-требования', from: 1094, to: 1358 },
]

async function ag(prompt, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await agent(prompt, attempt === 1 ? opts : { ...opts, label: opts.label + '#' + attempt })
    if (r) return r
    log('Нет результата у ' + opts.label + ' (попытка ' + attempt + '/3)')
  }
  return null
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    counts: {
      type: 'object',
      properties: { implemented: { type: 'integer' }, partial: { type: 'integer' }, missing: { type: 'integer' }, not_code: { type: 'integer' } },
    },
    top_gaps: { type: 'array', items: { type: 'string' }, description: '≤ 8 самых важных пробелов этой части (кратко)' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'top_gaps'],
}

phase('Audit')
const jobs = []

// --- 9 аудиторов требований ---
for (const s of SECTIONS) {
  jobs.push(() => ag([
    COMMON, '',
    '=== ЗАДАНИЕ: аудит требований блока «' + s.title + '» ===',
    'Файл требований: ' + REQ + ' (≈230 КБ). Твой блок — строки ' + s.from + '–' + s.to + ' (читай ТОЛЬКО их через Read с offset=' + s.from + ' и limit=' + (s.to - s.from + 1) + ', частями по ≤ 400 строк). Для КАЖДОГО REQ-NNN в блоке (заголовки «### REQ-NNN …») определи статус по коду и тестам прототипа (Grep по REQ-NNN, TST-NN, именам функций из блока; читай нужные участки кода).',
    REQ_SCHEMA_NOTE,
    'Запиши ' + GAP + '\\req-' + s.key + '.json. В отчёте верни counts (по статусам), top_gaps (до 8, с REQ-ID), notes.',
  ].join('\n'), { label: 'audit:req-' + s.key, phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))
}

// --- 5 тематических аудитов ---
jobs.push(() => ag([
  COMMON, '',
  '=== ЗАДАНИЕ: аудит АЛГОРИТМОВ ALG-01…14 против кода ===',
  'Страницы ' + W + '\\algorithms\\alg-NN-*.md (раздел «Реализация в прототипе» + псевдокод + «Не в v1»/v2-части). Для каждого ALG: (1) какие функции из страницы НЕ реализованы или реализованы частично (сверь экспорты engine/*.mjs; известно: ALG-06 on_posted_income/on_posted_payment не реализованы; W_RESERVE_BEHIND без числа пропущенных взносов; нет построителя fx_obs_bp из ws.rates); (2) какие возможности алгоритма не доведены до интерфейса демо (engine есть, UI нет — например, Монте-Карло P10/P50/P90, backtest, calibration, hledger-экспорт, CSV-мастер, match_plan_to_fact); (3) какие v2/«Не в v1» части описаны в странице и могут быть добавлены в прототип без изменения канона. Запиши ' + GAP + '\\alg-audit.md: таблица | ALG | что есть | чего нет в engine | чего нет в UI | предложение (аддитивное) | усилие | и список из ≥ 15 конкретных пунктов «что дописать». Верни top_gaps.',
].join('\n'), { label: 'audit:algorithms', phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))

jobs.push(() => ag([
  COMMON, '',
  '=== ЗАДАНИЕ: аудит ЭКРАНОВ и сценариев UX против демо ===',
  'Страницы ' + W + '\\product\\03-ux-screens.md, 01-personas-jtbd.md (путь «первые 10 минут», JTBD), ' + W + '\\product\\17-start-plan.md (если есть), ' + W + '\\ideas\\proposal-product.md (идеи IDEA-30…59) и демо ' + P + '\\demo\\. Составь инвентарь: каждый экран/состояние/поток/микротекст из документации → есть в демо / частично / нет (с доказательством из app.mjs/i18n.mjs). Особое внимание: онбординг и «первый прогноз за ≤ 10 минут», формы ввода (операция, плановое правило, доход по часам, якорь остатка, налоговое правило, sinking), настройки (буфер, горизонт, режимы), пустые/ошибочные/«впритык»/«нельзя» состояния, календарь волн, мастер миграции из таблиц (IDEA-32), режим «в магазине» (IDEA-58, v1.1), оповещения (IDEA-?), семья (v1.1), ES-локализация (v1.1), печать/экспорт отчёта, горячие клавиши. Запиши ' + GAP + '\\ux-audit.md: таблица | экран/поток | в документации | в демо | пробел | предложение | усилие | и «10 самых ценных UX-дополнений».',
].join('\n'), { label: 'audit:ux', phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))

jobs.push(() => ag([
  COMMON, '',
  '=== ЗАДАНИЕ: аудит ПЛАТФОРМЕННЫХ и продуктовых страниц против прототипа ===',
  'Страницы ' + W + '\\product\\{04-data-model,05-architecture,06-ai-assistant-spec,07-privacy-security,08-tax-rules-engine,09-import-export,10-roadmap,13-metrics}.md и ADR-005 (local-first), ADR-010, ADR-011, ADR-013, ADR-015. Найди, что описано, но не сделано, особенно в слое вокруг движка: хранилище (IndexedDB/localStorage, схема миграций, persist(), Web Lock), PWA (manifest, service worker, офлайн-оболочка), файл-копия и напоминание (backup.remind_events = 50), «удалить всё»/квитанция, экспорт hledger/CSV из UI, шифрование (E2E, WebCrypto) и op-log синхронизация (v2), MCP-сервер инструментов (v2), режимы ИИ A1–A3 и предпросмотр payload (v2), метрики-файл runway-metrics/1, аналитика без слежки, журнал вызовов ассистента, i18n-плюрали, ES. Для каждого пункта: что именно в документации, что в коде, можно ли ДОБАВИТЬ в прототип без сервера и зависимостей (да/нет/частично), усилие. Запиши ' + GAP + '\\platform-audit.md (таблица + «что реально добавить в прототип сейчас» + «что требует продукта/сервера/решения владельца»).',
].join('\n'), { label: 'audit:platform', phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))

jobs.push(() => ag([
  COMMON, '',
  '=== ЗАДАНИЕ: аудит ИДЕЙ против реализации ===',
  'Страницы ' + W + '\\ideas\\new-ideas.md (каталог IDEA-01…99 с решениями), ' + W + '\\ideas\\better-than-budget-guru.md (бэклог UP-01…39), ' + W + '\\ideas\\red-team-critique.md (v1-срез и «недостающие идеи» IDEA-90…99). Для каждой идеи с решением «принять v1»/«принять позже» и каждого UP-пункта: реализовано в прототипе (доказательство) / частично / нет; можно ли добавить АДДИТИВНО в прототип сейчас. Запиши ' + GAP + '\\ideas-audit.md: таблица | ID | название | решение в каталоге | статус в коде | предложение | усилие |, затем «Топ-15 идей, которые усилят демонстрацию отличий от Budget Guru и реализуемы за ≤ 2 дня каждая». Верни top_gaps.',
].join('\n'), { label: 'audit:ideas', phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))

jobs.push(() => ag([
  COMMON, '',
  '=== ЗАДАНИЕ: аудит КАЧЕСТВА и «хвостов» тестирования ===',
  'Источники: ' + W + '\\product\\16-prototype-findings.md (разделы: подозрения на канон, hardening, todo/skip-тесты, P0/P1/P2), ' + OPS + '\\workflow3-result.json, tests/adversarial/*, 13 test.todo и 1 skip (найди Grep-ом test.todo / todo: / skip:), ' + W + '\\product\\11-testing-strategy.md. Составь по каждому открытому пункту: что именно сломано/не закрыто в коде (с путём и строкой), как исправить АДДИТИВНО (новые проверки, новые функции, не удаление кода), какой тест надо дописать, усилие. Особо: P0 из findings (одиночная нога перевода; слепые зоны верификатора — знак минус, символы Cf, ссылочная разметка Markdown; parse_amount_cell «12,50»→1250,00; белый список идентификаторов), класс __proto__ в calibration.lag_observations/timeline.rule_statuses/flow_calibration, нереализованные on_posted_income/on_posted_payment, W_RESERVE_BEHIND без чисел, fx_obs_bp, оракул hledger (TST-44, бинаря нет), производительность TST-54. Запиши ' + GAP + '\\quality-audit.md и ' + GAP + '\\quality-backlog.json (массив {id, title, module, severity, fix, test, effort}). Верни top_gaps.',
].join('\n'), { label: 'audit:quality', phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))

const audits = await parallel(jobs)
const okA = audits.filter(Boolean)
log('Аудит: ' + okA.length + '/' + jobs.length)

phase('Synthesis')
const synth = await ag([
  COMMON, '',
  '=== РОЛЬ: СИНТЕЗАТОР БЭКЛОГА ===',
  'Аудиторы записали в ' + GAP + ': req-*.json (статусы всех 155 требований), alg-audit.md, ux-audit.md, platform-audit.md, ideas-audit.md, quality-audit.md, quality-backlog.json. ПРОЧИТАЙ ВСЕ (JSON-ы можно свести скриптом node -e: посчитай статусы по блокам, список missing/partial по приоритету Must/Should).',
  '',
  'ЗАДАЧИ',
  '1. Запиши страницу ' + W + '\\product\\18-implementation-gap-analysis.md (type: product, status: draft, frontmatter по CLAUDE.md, updated: 2026-10-05, sources со ссылками на _ops/gap/*). Разделы: (а) «Резюме» — главные цифры (сколько из 155 REQ реализовано/частично/нет/не код; отдельно Must·v1), что прототип УЖЕ доказывает, где зияющие дыры; (б) «Покрытие по блокам» — таблица | блок | реализовано | частично | нет | не код | Must·v1 не закрыто |; (в) «Чего нет — по слоям» (engine / ui / infra / process) с REQ-ID; (г) «Что в документации, но не в приложении» — самое важное простыми словами для владельца (≥ 20 пунктов, каждый со ссылкой на REQ/ALG/IDEA); (д) «ПРИОРИТИЗИРОВАННЫЙ БЭКЛОГ ДОПИСЫВАНИЯ» — feature packs FP-01…FP-12 (каждый: название, зачем, состав, какие REQ/ALG/IDEA закрывает, какие файлы НОВЫЕ и какие существующие нужно лишь дополнить, усилие, зависимости, критерии приёмки с TST/REQ); (е) «ВОЛНА 1 к реализации сейчас» — набор packs, реализуемых целиком в прототипе без сервера и зависимостей, в порядке зависимостей, с границами владения файлами (чтобы агенты не конфликтовали; app.mjs — один «интегратор», остальное — новые файлы demo/*.mjs и engine/*.mjs); (ж) «Волны 2–3 и то, что требует решений владельца/продукта»; (з) «Риски дописывания» (рост app.mjs, дублирование, регрессии) и меры. Объём 3500–6000 слов, много таблиц. Имена feature packs/ID — только FP-NN (не REQ/ADR/IDEA/ALG/TST/RISK).',
  '2. Запиши ' + GAP + '\\backlog.json — массив {id: "FP-01", title, wave: 1|2|3, effort: "S|M|L", depends_on: [], reqs: [], new_files: [], touched_files: [], acceptance: ["..."], owner_hint: "engine|ui|infra"} — машиночитаемый бэклог для следующего воркфлоу реализации (проверь JSON.parse).',
  '3. Запусти node ' + ROOT + '\\tools\\lint.mjs и node ' + ROOT + '\\tools\\lint_vocab.mjs; исправь замечания в своей странице (ссылки только на существующие файлы; страница должна иметь ≥ 3 внутренних ссылки и раздел «Связанные страницы»).',
  '4. В отчёте верни: статусные цифры, названия packs волны 1 с оценками, и 5 решений владельца, без которых волну 2 не начать.',
].join('\n'), {
  label: 'synthesis:backlog', phase: 'Synthesis', effort: 'high',
  schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' } },
      req_counts: { type: 'object', properties: { implemented: { type: 'integer' }, partial: { type: 'integer' }, missing: { type: 'integer' }, not_code: { type: 'integer' } } },
      wave1: { type: 'array', items: { type: 'string' }, description: 'FP-NN — название — оценка' },
      owner_decisions: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['files', 'wave1', 'summary'],
  },
})

return { audits: okA, synthesis: synth }
