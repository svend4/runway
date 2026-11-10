export const meta = {
  name: 'runway-gap-reaudit',
  description: 'Повторный аудит «документация ↔ реализация» после волн 1–2 и этапа S1: статусы 155 REQ, ALG, UX, платформа, идеи, качество → проверка выборкой → страница 19 и бэклог волны 3',
  phases: [
    { title: 'Audit', detail: '9 блоков REQ + 3 тематических аудита, по три параллельно, только чтение' },
    { title: 'Verify', detail: 'состязательная выборочная проверка утверждений «реализовано»' },
    { title: 'Synthesis', detail: 'страница 19 и бэклог волны 3 с отметкой «нужно решение владельца»' },
  ],
}

const ROOT = 'C:/xampp/htdocs/01/301/runway'
const W = ROOT + '/wiki'
const GAP1 = ROOT + '/_ops/gap'
const GAP2 = ROOT + '/_ops/gap2'
const P = ROOT + '/prototype'
const REQ = W + '/product/02-requirements.md'

const COMMON = [
  'Ты — аудитор проекта «Runway» (' + ROOT + '): LLM-вики (паттерн Карпати) + исполняемый прототип приложения-прогнозиста денежного потока (чистый JS, Node 24, без зависимостей). Сегодня 2026-10-10. Пиши по-русски.',
  'ЦЕЛЬ ГРУППЫ: честно ответить владельцу, ЧТО ИЗ ТОГО, ЧТО ОПИСАНО В ДОКУМЕНТАЦИИ, РЕАЛИЗОВАНО В ПРИЛОЖЕНИИ ПОСЛЕ ТРЁХ ВОЛН РАБОТ, а что нет. Первый аудит был 2026-10-05 (страница ' + W + '/product/18-implementation-gap-analysis.md и файлы ' + GAP1 + '/*): тогда из 155 REQ реализовано 54, частично 76, нет 21, не код 4. С тех пор сделаны: волна 1 (FP-01…FP-09: каркас расширений, укрепление движка, настройки, быстрый ввод и «Отменить», хранение IndexedDB и файл-копия, мастер импорта CSV/hledger, конструктор сценариев и «почему», формы данных, витрины), этап S1 (set_as_of «Сегодня», единая стопка «Отменить», порядок фокуса, слот waves.card, оговорка горизонта), волна 2 (FP-10 мастер «Старт», калькулятор v0.html, метрики на устройстве; FP-11 сверка, качество прогноза, вероятностная полоса по согласию, backtest_report, anonymize; FP-12 PWA, Worker, воспроизводимая сборка, «О программе», bench/contrast/mutate/fuzz).',
  'ГДЕ ЧТО ЛЕЖИТ. Прототип: ' + P + ' — engine/*.mjs (31 модуль), demo/*.mjs (72 модуля; пакеты pack_fp03…pack_fp12.mjs, реестр ext.mjs, список пакетов ext_manifest.mjs), demo/i18n/*, demo/css/*, demo/v0.html, tools/*.mjs, tests/*.test.mjs (94 файла, 2155 тестов), README.md (карта модулей и тестов, ограничения), demo/README_ext.md. Приёмки: ' + ROOT + '/_ops/impl/wave1-acceptance.md и wave2-acceptance.md; план волны 2: ' + ROOT + '/_ops/impl/wave2-plan.md. Канон: ' + ROOT + '/_ops/design-brief.md, canon-decisions.md. Вики: ' + W + '.',
  '',
  'ПРАВИЛА',
  '- ТОЛЬКО ЧТЕНИЕ кода и вики. Не правь prototype/*, wiki/*, raw/*, data/*, tools/*, _ops/design-brief.md и др. Пиши ТОЛЬКО свои файлы в ' + GAP2 + ' (папка может ещё не существовать — создай её командой mkdir; несколько агентов создают одну папку — это нормально).',
  '- Каждое утверждение «реализовано» подтверждай доказательством: путь файла + имя функции или теста (Grep по REQ-NNN, TST-NN, имени функции в prototype/). «Реализовано» = есть код И тест, который это проверяет. Нет теста — partial. Реализовано только в движке без экрана, если требование про экран — partial.',
  '- Не выдумывай. Сомневаешься — status partial и поясни, что проверить. Не доверяй отчётам волн слепо: проверяй по коду.',
  '- Предложения «что сделать» — конкретные, АДДИТИВНЫЕ (новые функции/файлы/экраны), оценка S/M/L. Для каждого пробела отметь needs_owner: true, если для работы нужно решение владельца (канон v1.2, политика вероятностей, юридические формулировки, платформа/сервер, внешние сервисы, деньги/лицензии) — и в чём вопрос.',
  '- Память машины мала: НЕ запускай тесты и серверы вообще; читай и ищи (Grep/Glob/Read). Если без запуска не обойтись — ровно один файл теста: cd ' + P + ' и node --test --test-timeout=120000 --test-concurrency=1 tests/<файл>.test.mjs.',
  '- JSON-файл проверь: node -e "JSON.parse(require(\'fs\').readFileSync(\'<путь>\',\'utf8\'))".',
].join('\n')

const REQ_NOTE = [
  'ФОРМАТ ФАЙЛА: массив объектов — по одному на КАЖДОЕ REQ-NNN твоего блока, без пропусков:',
  '{ "id": "REQ-001", "title": "...", "priority": "Must|Should|Could|Won\'t", "phase": "v0|v1|v1.1|v2|—", "status": "implemented|partial|missing|not_code", "prev_status": "статус из первого аудита (' + GAP1 + '/req-<ключ>.json)", "changed": true|false, "layer": "engine|ui|infra|process|business", "evidence": "пути файлов + функции/тесты", "gaps": "чего именно не хватает (пусто, если implemented)", "proposal": "что дописать (аддитивно)", "effort": "S|M|L|—", "needs_owner": true|false, "owner_question": "если needs_owner" }',
  'Приоритет и фазу бери из блока REQ (строка «Приоритет и фаза»). Первым делом прочитай прежний файл ' + GAP1 + '/req-<ключ>.json для своего блока: он даёт прежние статусы; затем для КАЖДОГО требования перепроверь по текущему коду (волны могли закрыть, а могли и сломать).',
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
  { key: 'quality-ops', title: 'Надёжность и производительность + Доступность + Тестируемость + Операционные и бизнес-требования', from: 1094, to: 1400 },
]

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    counts: { type: 'object', properties: { implemented: { type: 'integer' }, partial: { type: 'integer' }, missing: { type: 'integer' }, not_code: { type: 'integer' }, changed_since_first_audit: { type: 'integer' } } },
    top_gaps: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'top_gaps'],
}

async function ag(prompt, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await agent(prompt, attempt === 1 ? opts : { ...opts, label: opts.label + '#' + attempt })
    if (r) return r
    log('Нет результата у ' + opts.label + ' (попытка ' + attempt + '/3)')
  }
  return null
}

phase('Audit')
const jobs = []
for (const s of SECTIONS) {
  jobs.push(() => ag([
    COMMON, '',
    '=== ЗАДАНИЕ: повторный аудит требований блока «' + s.title + '» ===',
    'Файл требований: ' + REQ + '. Твой блок — строки ' + s.from + '–' + s.to + ' (читай ТОЛЬКО их через Read с offset=' + s.from + ' и limit=' + (s.to - s.from + 1) + ', частями по ≤ 120 строк; если блок короче — до конца файла; границы блока ориентировочные: берёшь все REQ-NNN, чьи заголовки лежат в этом диапазоне, ничего не пропуская и не беря чужого).',
    REQ_NOTE.split('<ключ>').join('' + s.key),
    'Запиши ' + GAP2 + '/req-' + s.key + '.json. В отчёте верни counts (по статусам и число изменившихся с первого аудита), top_gaps (до 8, с REQ-ID), notes.',
  ].join('\n'), { label: 'audit:req-' + s.key, phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))
}
jobs.push(() => ag([
  COMMON, '',
  '=== ЗАДАНИЕ: повторный аудит АЛГОРИТМОВ ALG-01…14 и ЭКРАНОВ UX ===',
  'Часть 1: страницы ' + W + '/algorithms/alg-NN-*.md (раздел «Реализация в прототипе», псевдокод, v2-части) против engine/ и demo/: для каждого ALG — что реализовано в движке, что доходит до экрана демо (теперь: Старт, Сверка, Качество прогноза, полоса, v0, Метрики…), чего нет. Часть 2: ' + W + '/product/03-ux-screens.md, 01-personas-jtbd.md, 17-start-plan.md против демо (инвентарь экранов, форм, состояний и «первых 10 минут»). Первый аудит: ' + GAP1 + '/alg-audit.md и ux-audit.md — прочитай и отметь, что изменилось. Запиши ' + GAP2 + '/alg-ux-audit.md (таблицы + список пробелов с needs_owner). В отчёте верни files, counts (если применимо), top_gaps, notes.',
].join('\n'), { label: 'audit:alg-ux', phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))
jobs.push(() => ag([
  COMMON, '',
  '=== ЗАДАНИЕ: повторный аудит ПЛАТФОРМЫ и КАЧЕСТВА ===',
  'Платформа: ' + W + '/product/{04-data-model,05-architecture,06-ai-assistant-spec,07-privacy-security,08-tax-rules-engine,09-import-export,10-roadmap,13-metrics}.md и ADR-005, 010, 011, 013, 015 против прототипа (PWA, Worker, хранилище, шифрование, синхронизация, ассистент A0–A3 и журнал вызовов, налоговые шаблоны стран, OFX, семья, оповещения…). Качество: ' + W + '/product/11-testing-strategy.md (TST-01…60 и гейт релиза), 16-prototype-findings.md (todo/skip, подозрения на канон К-1…К-41), _ops/gap/quality-audit.md и quality-backlog.json: какие хвосты закрыты (FUZZ_N, замок арифметики на 500 журналах, оракул hledger, tsc, мутации ≥30, нагрузочные пороги), какие нет. Запиши ' + GAP2 + '/platform-quality-audit.md. Верни files, top_gaps, notes.',
].join('\n'), { label: 'audit:platform-quality', phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))
jobs.push(() => ag([
  COMMON, '',
  '=== ЗАДАНИЕ: повторный аудит ИДЕЙ и ДОРОЖНОЙ КАРТЫ ===',
  'Страницы ' + W + '/ideas/new-ideas.md (IDEA-01…99), better-than-budget-guru.md (UP-01…39), red-team-critique.md, ' + W + '/product/10-roadmap.md и 17-start-plan.md против реализации: что из идей реализовано (с доказательством), что нет, что осталось v1.1/v2 и что невозможно без сервера/денег/людей. Первый аудит: ' + GAP1 + '/ideas-audit.md. Запиши ' + GAP2 + '/ideas-roadmap-audit.md: таблица IDEA/UP со статусом implemented|partial|missing|rejected|not_code, прежним статусом, доказательством, needs_owner. Верни files, counts, top_gaps, notes.',
].join('\n'), { label: 'audit:ideas-roadmap', phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }))

const audits = []
for (let i = 0; i < jobs.length; i += 3) {
  const chunk = jobs.slice(i, i + 3)
  const r = await parallel(chunk)
  audits.push(...r)
  log('Аудит: завершено ' + Math.min(i + 3, jobs.length) + ' из ' + jobs.length)
}
const okA = audits.filter(Boolean)
log('Аудит: результат у ' + okA.length + ' из ' + jobs.length)

phase('Verify')
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    checked: { type: 'integer' },
    refuted: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, claimed: { type: 'string' }, correct_status: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'correct_status', 'why'] } },
    notes: { type: 'string' },
  },
  required: ['checked', 'refuted', 'notes'],
}
const VGROUPS = [
  { name: 'v1', keys: ['core-data', 'q1', 'q2-q3'] },
  { name: 'v2', keys: ['reserves-hours', 'fx-debt', 'io'] },
  { name: 'v3', keys: ['ui', 'privacy-ai', 'quality-ops'] },
]
const vres = await parallel(VGROUPS.map((g) => () => ag([
  COMMON, '',
  '=== РОЛЬ: СОСТЯЗАТЕЛЬНЫЙ ПРОВЕРЯЮЩИЙ АУДИТА (' + g.name + ') ===',
  'Аудиторы записали ' + GAP2 + '/req-<ключ>.json для блоков: ' + g.keys.join(', ') + '. Твоя задача — найти ОШИБОЧНЫЕ утверждения. Для каждого блока возьми не менее 10 требований со статусом implemented (приоритет — те, у которых changed = true, и все Must·v1) и 5 со статусом missing или partial, и попробуй ОПРОВЕРГНУТЬ: открой названные в evidence файлы и тесты, убедись, что функция есть и вызывается из экрана/пути (если требование про экран), что тест реально проверяет требование (не тавтология); для missing — поищи реализацию по другим именам. Исправляй НЕ сам файл аудитора, а запиши список расхождений в ' + GAP2 + '/verify-' + g.name + '.json (массив {id, claimed, correct_status, why}) и верни его в отчёте. Пустой список — тоже честный результат, но только если ты реально проверил (укажи число проверенных).',
].join('\n'), { label: 'verify:' + g.name, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' })))
const refuted = vres.filter(Boolean).flatMap((v) => v.refuted)
log('Проверка выборкой: опровергнуто утверждений — ' + refuted.length)

phase('Synthesis')
const synth = await ag([
  COMMON, '',
  '=== РОЛЬ: СИНТЕЗАТОР ===',
  'Прочитай ВСЁ в ' + GAP2 + ': req-*.json (9 файлов), alg-ux-audit.md, platform-quality-audit.md, ideas-roadmap-audit.md, verify-*.json (расхождения, найденные проверяющими: ПРИМЕНИ их — исправь статусы в req-*.json скриптом node, сохранив прежнюю структуру, и перечисли исправления в странице), а также прежние ' + GAP1 + '/backlog.json и ' + W + '/product/18-implementation-gap-analysis.md.',
  'ЗАДАЧИ',
  '1. Запиши страницу ' + W + '/product/19-implementation-status-after-wave2.md (type: product, status: draft, frontmatter по ' + ROOT + '/CLAUDE.md, updated: 2026-10-10, sources: файлы _ops/gap2/*). Разделы: (а) Резюме: статусные цифры 155 REQ было/стало (таблица), Must·v1 отдельно, число изменившихся и число опровергнутых проверкой; (б) Покрытие по блокам (было/стало); (в) ЧТО В ДОКУМЕНТАЦИИ, НО НЕ В ПРИЛОЖЕНИИ — сгруппировано: движок / интерфейс / платформа / процесс и люди / нужно решение владельца; с REQ-ID; (г) Алгоритмы, экраны, идеи: что реализовано, что нет (сводно); (д) Хвосты качества; (е) Предложение волны 3: пакеты FP-13… (S/M/L, зависимости, критерии приёмки, какие REQ закрывают) — отдельно «можно делать без решений владельца» и «ждёт решения владельца» (с формулировкой вопроса и вариантами); (ж) Что осталось на люди (юр. ревью, вычитка RU/EN, лицензия, ручной проход PWA в Chrome/Edge, интервью и пр.); (з) Допущения и границы вывода. Таблицы — где уместно. Ссылки только на существующие файлы; в конце раздел «Связанные страницы» (минимум 2 ссылки на существующие страницы).',
  '2. Запиши ' + GAP2 + '/backlog-wave3.json — массив {id: "FP-13", title, wave: 3, effort, depends_on, reqs, new_files, touched_files, acceptance: [..], owner_hint, needs_owner: true|false, owner_question}.',
  '3. Запусти из ' + ROOT + ': node tools/lint.mjs и node tools/lint_vocab.mjs; исправь замечания по своей странице (в тексте не пиши запрещённые формулировки: «безопасно», «гарантируем», «спокойно» как вердикт и т. п.; до сдачи страница должна иметь входящую ссылку — добавь её в раздел «Связанные страницы» страницы ' + W + '/product/18-implementation-gap-analysis.md одной строкой).',
  '4. Верни: цифры было/стало (REQ всего и Must·v1), список пакетов волны 3 (id — название — effort — needs_owner), топ-10 самых важных нереализованных вещей из документации, и список вопросов владельцу (с вариантами).',
].join('\n'), {
  label: 'synthesis', phase: 'Synthesis', effort: 'high',
  schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' } },
      req_before: { type: 'object', properties: { implemented: { type: 'integer' }, partial: { type: 'integer' }, missing: { type: 'integer' }, not_code: { type: 'integer' } } },
      req_after: { type: 'object', properties: { implemented: { type: 'integer' }, partial: { type: 'integer' }, missing: { type: 'integer' }, not_code: { type: 'integer' } } },
      must_v1_after: { type: 'object', properties: { implemented: { type: 'integer' }, partial: { type: 'integer' }, missing: { type: 'integer' }, not_code: { type: 'integer' } } },
      wave3: { type: 'array', items: { type: 'string' } },
      top_unimplemented: { type: 'array', items: { type: 'string' } },
      owner_questions: { type: 'array', items: { type: 'string' } },
      corrections_applied: { type: 'integer' },
    },
    required: ['files', 'req_after', 'wave3', 'top_unimplemented', 'owner_questions'],
  },
})
return { audits: okA.length, refuted: refuted.length, synth }
