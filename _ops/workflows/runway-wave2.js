export const meta = {
  name: 'runway-wave2',
  description: 'Runway волна 2 по очереди: FP-10 мастер Старт/v0/метрики → FP-11 сверка/качество/полоса → FP-12 PWA/Worker/сборка; у каждого независимая проверка',
  phases: [
    { title: 'FP-10 Старт', detail: 'мастер, калькулятор v0, метрики, шаблоны' },
    { title: 'FP-11 Сверка', detail: 'очередь сверки, качество, полоса по согласию' },
    { title: 'FP-12 Платформа', detail: 'PWA, Worker, сборка, замеры, мутации' },
  ],
}

const ROOT = 'C:/xampp/htdocs/01/301/runway'

const CTX = `
КОНТЕКСТ. Проект «Runway» (${ROOT}) — прототип приложения-прогнозиста денежного потока: чистый JavaScript (ES-модули, без зависимостей, Node 24), движок prototype/engine, демо prototype/demo (реестр расширений ext.mjs + пакеты pack_fpNN.mjs, список пакетов — ext_manifest.mjs), тесты prototype/tests (node --test). Пишите по-русски (комментарии, строки интерфейса, названия тестов); идентификаторы — snake_case. ОБЯЗАТЕЛЬНО прочитайте перед работой: ${ROOT}/_ops/impl/wave2-plan.md (предварительные решения владельца-координатора по 5 вопросам — они обязательны), ${ROOT}/STATE.md (блок «ТЕКУЩИЙ ШАГ»), ${ROOT}/prototype/README.md, ${ROOT}/prototype/demo/README_ext.md, запись вашего пакета в ${ROOT}/_ops/gap/backlog.json (поля scope, acceptance, new_files, touched_files, reqs) и страницу ${ROOT}/wiki/product/18-implementation-gap-analysis.md (раздел вашего пакета), а также файлы, которые будете менять; опирайтесь на уже сделанные пакеты (FP-01…FP-09, этап S1) как на образец стиля.

ЖЁСТКИЕ ПРАВИЛА.
1. ТОЛЬКО АДДИТИВНО: не удалять и не ослаблять существующий код и тесты. Менять ожидание существующего теста можно, только если фича намеренно меняет поведение (например, число пакетов/разделов/слотов); каждое такое изменение перечислите в decisions. Общие файлы (app.mjs, ext.mjs, ext_manifest.mjs, i18n.mjs, index.html, style.css, serve.mjs, tests/demo.test.mjs) — минимальные правки, перечислите их в shared_files_touched.
2. Безопасность интерфейса (CSP script-src 'self'; style-src 'self'): никаких innerHTML/outerHTML/eval/new Function/inline-стилей/обработчиков-строк/внешних адресов/CDN; текст пользователя в страницу — только через textContent (dom.mjs h()); пользовательские тексты в контекст ошибок не класть. Хранилища общего localhost (localStorage, кэши, IndexedDB, сервис-воркеры) делятся с другими проектами пользователя: все ключи и имена — с префиксом runway, сервис-воркеры только в своей области, чужое не трогать (урок UI-2).
3. Строки интерфейса — RU и EN, паритет ключей и плейсхолдеров (тесты TST-56: каждый ключ каталога используется литералом в коде пакета; RU-строка содержит русские буквы). Запрещённые формулировки (engine/vocab.json → forbidden_phrases; «безопасно», «гарантируем», «спокойно» как вердикт, «за N минут» без измерения и т. п.) не писать; после работы из ${ROOT}: node tools/lint_vocab.mjs — 0 ошибок и node tools/lint.mjs — 0 ошибок. Налоговых, юридических и инвестиционных советов нет: налоги — только правила пользователя как данные; везде «расчёт по введённым данным и правилам, не консультация».
4. ПАМЯТЬ МАШИНЫ МАЛА (7,8 ГБ, свободно ~1,5 ГБ; приложение уже несколько раз зависало). РОВНО ОДИН процесс node за раз, только из ${ROOT}/prototype: node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs (один файл за раз). НИКОГДА не запускайте node --test без имени файла, не запускайте серверы и браузеры (если для проверки нужен serve.mjs — только на время одного запроса и сразу остановить), не создавайте фоновых процессов.
5. Не делать git-коммитов. Писать только внутри ${ROOT}. Папки других проектов не читать. STATE.md, wiki/log.md, wiki/index.md и страницы wiki/ НЕ править (делает координатор). Документацию вашего пакета вносите в prototype/README.md (карта модулей и тестов, ограничения) и prototype/demo/README_ext.md.
6. Золотые данные и канон не менять: data/g001*.json, tests/g001.golden.test.mjs, tests/arith.lock.json, engine/vocab.json. Новые служебные коды предупреждений — в расширениях (engine/warnings_ext.mjs-стиль), не в vocab.json. Новые модули engine/ — чистые (нет Date, Math.random, fetch, node:*), не реэкспортируются из index.mjs; добавьте строгие ранги в tests/purity.test.mjs по образцу модулей волны 1.
7. ПЕРЕД НАЧАЛОМ сделайте снимок: из ${ROOT} выполните node tools/snapshot.mjs --label wave2-<пакет>-before (он нужен проверяющему для additive_check).
8. Перед завершением прогоните по одному файлу ВСЕ тестовые файлы, которые ваша правка могла затронуть (минимум: ext, ext_boot, wave1_integration, demo, settings, settings_boot, entry_boot, nav_focus, undo_all, data_pack, data_actions, forms, purity, g001.golden, defaults_sync, plus ваши новые), и перечислите числа в результате. Красное — исправить или честно сообщить в open_issues.
9. Ответ — только структурированный объект по схеме.
`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    files_created: { type: 'array', items: { type: 'string' } },
    shared_files_touched: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, tests: { type: 'number' }, pass: { type: 'number' }, fail: { type: 'number' } }, required: ['file', 'tests', 'pass', 'fail'] } },
    decisions: { type: 'array', items: { type: 'string' } },
    open_issues: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['criterion', 'met', 'evidence'] } },
  },
  required: ['summary', 'files_changed', 'files_created', 'tests', 'decisions', 'open_issues', 'acceptance'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'defects'] },
    defects: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, where: { type: 'string' }, repro: { type: 'string' }, suggested_fix: { type: 'string' } }, required: ['severity', 'title', 'where', 'repro'] } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, tests: { type: 'number' }, pass: { type: 'number' }, fail: { type: 'number' } }, required: ['file', 'tests', 'pass', 'fail'] } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'defects', 'tests', 'notes'],
}

const ITEMS = [
  {
    id: 'FP-10',
    phase: 'FP-10 Старт',
    title: 'Мастер «Старт», калькулятор v0, шаблоны-скелеты, метрики на устройстве',
    spec: `
ЗАДАЧА FP-10 (метка снимка: wave2-fp10-before). Реализовать пакет по записи FP-10 из backlog.json и разделу FP-10 страницы 18, с предварительными решениями из wave2-plan.md (журнал — единственный источник; метрики только локально; юридическое ревью и вычитка RU/EN помечены как «ожидает людей», без утверждений о готовности).
Состав: 
 1) Пакет prototype/demo/pack_fp10.mjs (регистрация через register(ext), добавить в ext_manifest.mjs по образцу pack_fp03…09; app.mjs пакет по имени не знает) с экраном #start «Старт» (prototype/demo/wizard.mjs + i18n/start.mjs + css/start.css): мастер из четырёх шагов и буфера — (1) счёт и остаток, (2) не менее трёх обязательств (повторяющиеся платежи), (3) ближайший доход, (4) повседневные траты, (+) буфер; прогноз появляется при готовности данных s ≥ 3 (REQ-029/REQ-110; используйте readiness.score и причины движка, не придумывайте свои); запись только через общий путь (ctx.edit / ctx.set_ws, виды правок из ws_edit.mjs: upsert_account, set_anchor, upsert_rule, upsert_stream, set_param и др.; недостающие виды — через register_edit пакета с проверкой); поля валидируются (E_* коды канона, текст ошибки рядом с полем, введённое не повторяется); шаги можно пропускать и возвращаться; время шагов пишется в ЛОКАЛЬНЫЙ журнал без сумм и дат (только шаг, длительность в секундах, дата-час в виде порядкового номера сеанса — календарные даты в метриках запрещены).
 2) Набор prototype/data/g001-empty.json (пустой набор: s < 3, без счетов или с одним счётом без обязательств) и строки в DATASETS (demo/i18n.mjs, ключи ds.<id>): через него достижим экран ov.empty и покрыт тестом отрисовки; шаблон prototype/data/templates/freelancer-skeleton.json — скелет без предзаполненных ставок (rate_bp отсутствует/null), со сроком годности правил (REQ-068, TST из FP-02 о ставках не должен краснеть); кнопка «Начать с шаблона» в мастере (по желанию, если укладывается).
 3) Калькулятор v0: prototype/demo/v0.html + v0.mjs (отдельная страница без мастера и без хранилища: остаток, до 12 повторяющихся платежей, до 3 поступлений с привычной задержкой, покупка; ограничения 12 и 3 проверяются и объясняются) — считает ТЕМ ЖЕ движком; на входных данных, эквивалентных G-001, даёт те же вердикт (FRAGILE для покупки 300 € на 2026-10-12), минимум, раннюю дату и максимум (тест сверяет с golden); состояние — файл JSON (выгрузка/загрузка; формат — runway-journal/1 или рабочая область, как принято в демо); v0.html подчиняется тому же CSP (script-src 'self'), ссылки на v0 из мастера/«Данных» не нужны, но страница должна открываться по http://localhost/…/demo/v0.html и работать офлайн от остального приложения (минимум общих модулей).
 4) Метрики: prototype/demo/metrics.mjs — счётчики на устройстве и пакет runway-metrics/1 (JSON-схема в тесте: НЕТ сумм, НЕТ календарных дат, НЕТ идентификаторов пользователя, только агрегаты и порядковые номера); экран/карточка «Метрики на устройстве» показывает файл ЦЕЛИКОМ до скачивания, скачивание — по кнопке; хранение — localStorage под ключом с префиксом runway (чистится существующим «Удалить все данные» FP-05; добавьте тест, что eraseAll стирает ключ метрик и не трогает чужие); фраза «за N минут» без измерения запрещена линтером (lint_vocab --registry с prototype/demo/promises.json: добавьте записи обещаний пакета с level и test по образцу).
Тесты (новые файлы): prototype/tests/wizard.test.mjs, prototype/tests/v0.test.mjs, prototype/tests/metrics.test.mjs (+ при необходимости start_boot.test.mjs на заглушке DOM в настоящем app.mjs по образцу entry_boot.test.mjs): четыре шага и буфер на наборе g001-empty доводят s до 4 и показывают прогноз; ошибки полей; пропуск шагов; журнал шагов без сумм/дат; v0 = G-001; ограничения v0; схема метрик; eraseAll; шаблон без ставок; RU/EN; a11y (подписи полей, aria-live сообщений, фокус-заголовок); TST-56 каталог; TST-59 безопасность.`,
  },
  {
    id: 'FP-11',
    phase: 'FP-11 Сверка',
    title: 'Сверка план↔факт, качество прогноза, вероятностная полоса по согласию',
    spec: `
ЗАДАЧА FP-11 (метка снимка: wave2-fp11-before). Реализовать пакет по записи FP-11 из backlog.json и разделу FP-11 страницы 18, с решением №3 из wave2-plan.md (полоса и «при уверенности α» выключены по умолчанию, включаются явным согласием; метка «эксперимент, не обещание»; при n < 20 текст «в k из n»; без истории — отказ; в шаблонах ответов v1 ключа probability нет; режим expected по умолчанию остаётся недоступным mode_not_in_v1).
Состав:
 1) prototype/demo/pack_fp11.mjs (+ ext_manifest.mjs) с экранами «Сверка» (#reconcile: очередь просроченных/неподтверждённых плановых платежей: действия «подтвердить / привязать к плану / не относится / пропустить / отменить» — запись через общий путь, правки match/override через существующие виды ws_edit или новые через register_edit; подпись «Просрочено: ожидали …»; показ всех фактов с пагинацией; очередь пустеет после разбора; на наборе late просроченный платёж виден) и «Качество прогноза» (#quality: FRR, cry-wolf, n, дата замера на СИНТЕТИЧЕСКИХ журналах prototype/data/synthetic-journals с явной пометкой «синтетика»; карточка «Привычки платежей» только при n ≥ 10; чтение отчёта backtest).
 2) engine (чистые модули, не из index.mjs, строгие ранги в purity.test.mjs): prototype/engine/mc_inputs.mjs (fx_obs_from_rates и подготовка входов Монте-Карло), band_adapter.mjs (адаптер коридора P10/P50/P90 над montecarlo.mjs), expected.mjs (ряд expected как ОТОБРАЖАЕМАЯ оценка без снятия E_SCHEMA у mode='expected').
 3) prototype/tools/backtest_report.mjs (печатает и пишет в vocab-совместимый файл FRR, cry-wolf, n, дату на data/synthetic-journals; release_gate читает отчёт; для REQ-188 — число волн, доля волн из одного платежа, чувствительность к g±1 и S±3 на ≥ 10 журналах; дату передавать аргументом, не читать часы в чистых модулях), prototype/tools/anonymize.mjs (anonymize_journal: сдвиг дат кратно 7 дням, суммы × k, k в [0,5; 2], структура и связи сохраняются, детерминированный seed). 
 4) prototype/demo/prob_band.mjs и prob_buy.mjs: полоса P10–P90 на графике/в таблице и «при уверенности α максимум X» — за явным согласием (чекбокс + подтверждение на экране «Качество прогноза»; согласие в localStorage под ключом с префиксом runway, чистится «Удалить все данные», тест на это); по умолчанию выключено и НЕ влияет ни на вердикты OK/TIGHT/FRAGILE/NO, ни на числа Q1/Q3; при отсутствии истории — отказ с текстом; при n < 20 — «в k из n» вместо процентов.
Тесты (новые): reconcile.test.mjs (TST-40/41), quality_report.test.mjs (TST-55), anonymize.test.mjs, prob_band.test.mjs (TST-49), + тесты чистых модулей engine; RU/EN, a11y, TST-56/TST-59, purity, lint_vocab (никаких слов «гарантируем», «точный прогноз», «вероятность успеха» как обещания).`,
  },
  {
    id: 'FP-12',
    phase: 'FP-12 Платформа',
    title: 'PWA, Worker, воспроизводимая сборка, замеры, мутации, фаззинг',
    spec: `
ЗАДАЧА FP-12 (метка снимка: wave2-fp12-before). Реализовать по записи FP-12 из backlog.json и разделу FP-12 страницы 18, с решением №4 из wave2-plan.md. Пакет самый широкий — расставьте приоритеты и ЧЕСТНО отметьте в open_issues, что не доделано (лучше меньше, но проверено). Порядок: 
 (а) PWA: prototype/demo/manifest.webmanifest, sw.js (оболочка офлайн: список файлов оболочки берётся из манифеста хэшей (пункт в) либо статически сверяется тестом offline_inventory.test.mjs с ФАКТИЧЕСКИМ списком файлов demo/, engine/, data/ из импортов), pwa.mjs (регистрация воркера ТОЛЬКО на localhost/HTTPS, в своей области — каталог prototype/ (own_scope из data_actions/pack_fp05), кэши с префиксом runway-shell-), правки CSP в index.html и serve.mjs: только добавить manifest-src 'self' и worker-src 'self' (тест demo.test.mjs про CSP обновить намеренно и перечислить в decisions), MIME .webmanifest в serve.mjs, .htaccess рядом (AddType application/manifest+json .webmanifest; если Apache его не читает — документировать), иконки SVG без бинарных файлов; «Удалить все данные» (FP-05) должен снимать ТОЛЬКО свой воркер и свои кэши — добавить тест на чужие воркеры/кэши того же источника; стратегия обновления оболочки (версия по хэшу сборки, кнопка «Обновить» в «О программе», без тихой подмены).
 (б) Worker: prototype/demo/calc_worker.mjs + worker_client.mjs: analyze в модульном воркере с откатом на главный поток (без воркера/в Node), контракт сообщений проверяется worker_contract.test.mjs на заглушке; блокировка главного потока измеряется bench.
 (в) воспроизводимая сборка: prototype/tools/build_manifest.mjs (манифест sha256 всех файлов оболочки; двойная сборка даёт тот же манифест — тест), экран «О программе» (demo/about.mjs: версия движка, хэш сборки, число файлов оболочки, лицензии/сведения «нет внешних запросов после загрузки»), tools/verify.mjs (проверка манифеста), prototype/SPEC-format.md (формат runway-journal/1 и runway-metrics/1, если пакет FP-10 уже есть), jsconfig.json (без запуска tsc: зависимостей нет — отметить в open_issues).
 (г) замеры: prototype/tools/bench.mjs печатает p50/p95 пересчёта (TST-54), n и дату (дата — аргументом), результат — _ops/bench.json (на этой машине).
 (д) качество: prototype/tools/contrast.mjs (проверка контраста токенов CSS по WCAG, светлая и тёмная темы), prototype/tools/mutate.mjs (мутации арифметики для TST-52: не менее 30 мутантов money/dates, каждый должен ронять замок arith.lock/тесты; запуск ограниченный — по одному мутанту, на копии каталога в каталоге scratchpad, не в рабочем дереве!), ночной фаззинг — скрипт tools/fuzz_nightly.mjs (запуск короткий FUZZ_N=2000, полный не гонять), оракул hledger через Docker — только скрипт и документ (Docker не запускать).
Тесты (новые): pwa.test.mjs, worker_contract.test.mjs, offline_inventory.test.mjs, build_manifest.test.mjs, about.test.mjs, contrast.test.mjs (и при необходимости mutate-проверка). Приёмка REQ-120: инвентарь сетевых вызовов после загрузки равен 0 в сценариях Q1, Q3, импорт и экспорт; список файлов оболочки совпадает с манифестом хэшей; REQ-154: двойная сборка — тот же манифест. Браузер НЕ запускать (проверка в браузере — потом координатор): но напишите в open_issues список ручных проверок PWA (установка, офлайн, обновление, снятие воркера).`,
  },
]

const results = []
for (const it of ITEMS) {
  phase(it.phase)
  log('Начинаю ' + it.id + ': ' + it.title)
  let impl = await agent(CTX + '\n' + it.spec, { label: it.id + ' реализация', phase: it.phase, schema: IMPL_SCHEMA })
  if (!impl) { log(it.id + ': реализация не вернула результат'); results.push({ id: it.id, impl: null, verify: null }); continue }
  log(it.id + ' реализация: ' + impl.summary.slice(0, 250))

  const verify_prompt = CTX + `
РОЛЬ: НЕЗАВИСИМЫЙ ПРОВЕРЯЮЩИЙ (состязательный). Другой агент реализовал «${it.id} — ${it.title}». Найдите реальные дефекты, а не одобряйте. Вы НЕ переписываете реализацию; можете добавить свои тесты в НОВЫЙ файл prototype/tests/${it.id.toLowerCase().replace('-', '')}_adv.test.mjs (аддитивно) и запускать существующие по одному.
Спецификация, по которой работал реализатор:
${it.spec}
Отчёт реализатора (JSON): ${JSON.stringify(impl)}
Проверьте: (1) каждый критерий приёмки из backlog.json (запись ${it.id}) и из спецификации выполнен и доказан запущенным тестом — читайте тесты, ищите тавтологии, проверьте цифры на независимом пути; (2) регрессии: перезапустите по одному файлу затронутые тесты и сравните с отчётом; (3) аддитивность: из ${ROOT} node tools/additive_check.mjs <последний снимок с меткой wave2-${it.id.toLowerCase().replace('-', '')}-before из ${ROOT}/_backups> — ошибок «пропавший экспорт/файл» быть не должно, предупреждения о переименованных тестах перечислите; (4) безопасность интерфейса (innerHTML, inline-стили, сеть, textContent), хранилища общего localhost только с префиксом runway, паритет RU/EN, lint_vocab и lint — 0 ошибок, нет запрещённых обещаний; (5) честность чисел и текстов: никаких «гарантируем/точно/безопасно»; метрики без сумм и дат; вероятности не влияют на вердикты; (6) краевые случаи и гонки; (7) качество кода и документации (prototype/README.md, README_ext.md). Вердикт accept — только если нет дефектов high/medium.`
  let verify = await agent(verify_prompt, { label: it.id + ' проверка', phase: it.phase, schema: VERIFY_SCHEMA })
  if (verify) log(it.id + ' проверка: ' + verify.verdict + ', дефектов ' + verify.defects.length)

  const serious = verify ? verify.defects.filter((d) => d.severity === 'high' || d.severity === 'medium') : []
  if (verify && verify.verdict === 'defects' && serious.length > 0) {
    log(it.id + ': исправляю ' + serious.length + ' дефект(ов)')
    const fixed = await agent(CTX + `
РОЛЬ: ИСПРАВЛЕНИЕ ДЕФЕКТОВ после независимой проверки. Исходная задача:
${it.spec}
Что сделано (JSON): ${JSON.stringify(impl)}
Дефекты (high/medium — исправить обязательно, low — по возможности): ${JSON.stringify(verify.defects)}
Исправьте аддитивно, добавьте тест на каждый high/medium дефект, перезапустите затронутые файлы по одному, верните объект результата (summary — что исправлено).`, { label: it.id + ' исправление', phase: it.phase, schema: IMPL_SCHEMA })
    if (fixed) {
      impl = fixed
      const again = await agent(CTX + `
РОЛЬ: ПОВТОРНАЯ ПРОВЕРКА «${it.id}». Были дефекты: ${JSON.stringify(verify.defects)}. Отчёт исправления: ${JSON.stringify(fixed)}. Убедитесь, что каждый high/medium закрыт тестом, затронутые файлы (по одному) зелёные, additive_check, lint_vocab, lint без ошибок. Вердикт accept/defects.`, { label: it.id + ' повторная проверка', phase: it.phase, schema: VERIFY_SCHEMA })
      if (again) { verify = again; log(it.id + ' повторная проверка: ' + again.verdict + ', дефектов ' + again.defects.length) }
    }
  }
  results.push({ id: it.id, title: it.title, impl, verify })
}
return results
