export const meta = {
  name: 'runway-wave3a3',
  description: 'Runway волна 3а-3 (без решений владельца): FP-47 хвосты повторного аудита → независимая проверка и исправления',
  phases: [{ title: 'FP-47 Хвосты', detail: 'REQ-104, 095, 114, 178, 177, 067, 191' }],
}
const ROOT = 'C:/xampp/htdocs/01/301/runway'

const CTX = `
КОНТЕКСТ. Проект «Runway» (${ROOT}) — прототип приложения-прогнозиста денежного потока: чистый JavaScript (ES-модули, без зависимостей, Node 24), движок prototype/engine, демо prototype/demo (реестр расширений ext.mjs + пакеты pack_fpNN.mjs, список пакетов — ext_manifest.mjs), тесты prototype/tests (node --test). Пишите по-русски (комментарии, строки интерфейса, названия тестов); идентификаторы — snake_case. ОБЯЗАТЕЛЬНО прочитайте перед работой: ${ROOT}/STATE.md (блок «ТЕКУЩИЙ ШАГ»), ${ROOT}/prototype/README.md, ${ROOT}/prototype/demo/README_ext.md, вашу запись в ${ROOT}/_ops/gap2/backlog-wave3.json (поля scope, acceptance, reqs, new_files, touched_files), раздел «Дорожка 3а» страницы ${ROOT}/wiki/product/19-implementation-status-after-wave2.md и разделы про ваши REQ в ${ROOT}/_ops/gap2/req-*.json (статус, evidence, gaps, proposal), сами требования в ${ROOT}/wiki/product/02-requirements.md (Grep по REQ-NNN), канон ${ROOT}/_ops/design-brief.md (§14 главнее прочих) и файлы, которые будете менять. Образцы стиля — уже сделанные пакеты (FP-01…FP-12, этап S1, а также FP-18 и FP-14 из волны 3а: pack_fp14.mjs, debts, import_wizard и их тесты).

ЖЁСТКИЕ ПРАВИЛА.
1. ТОЛЬКО АДДИТИВНО: не удалять и не ослаблять существующий код и тесты. Менять ожидание существующего теста можно, только если фича намеренно меняет поведение; каждое такое изменение перечислите в decisions. Общие файлы (app.mjs, ext.mjs, ext_manifest.mjs, i18n.mjs, index.html, style.css, serve.mjs, tests/demo.test.mjs) — минимальные правки, перечислите в shared_files_touched.
2. Канон не менять: data/g001*.json, tests/g001.golden.test.mjs, tests/arith.lock.json, engine/vocab.json неприкосновенны; числа G-001 не меняются. Если ваш пакет затрагивает расчёт движка, сначала убедитесь, что golden и arith.lock остаются зелёными. Новые служебные коды предупреждений — в расширениях (engine/warnings_ext.mjs-стиль), не в vocab.json. Новые модули engine/ — чистые (нет Date, Math.random, fetch, node:*), не реэкспортируются из index.mjs; добавьте строгие ранги в tests/purity.test.mjs по образцу волн 1–2.
3. Безопасность интерфейса (CSP script-src 'self'; style-src 'self'): никаких innerHTML/outerHTML/eval/new Function/inline-стилей/обработчиков-строк/внешних адресов/CDN; текст пользователя в страницу — только через textContent (dom.mjs h()); пользовательские тексты в контекст ошибок не класть. Хранилища общего localhost (localStorage, кэши, IndexedDB, сервис-воркеры) делятся с другими проектами пользователя: все ключи и имена — с префиксом runway, чужое не трогать.
4. Строки интерфейса — RU и EN, паритет ключей и плейсхолдеров (тесты TST-56: каждый ключ каталога используется литералом в коде пакета; RU-строка содержит русские буквы). Запрещённые формулировки (engine/vocab.json → forbidden_phrases; «безопасно», «гарантируем», «спокойно» как вердикт, «за N минут» без измерения и т. п.) не писать; после работы из ${ROOT}: node tools/lint_vocab.mjs — 0 ошибок и node tools/lint.mjs — 0 ошибок. Налоговых, юридических и инвестиционных советов нет: налоги — только правила пользователя как данные; везде «расчёт по введённым данным и правилам, не консультация».
5. ПАМЯТЬ МАШИНЫ МАЛА (7,8 ГБ; приложение уже несколько раз зависало). РОВНО ОДИН процесс node за раз, только из ${ROOT}/prototype: node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs (один файл за раз). НИКОГДА не запускайте node --test без имени файла. Серверы и браузеры не запускайте; если для проверки всё же поднят serve.mjs — остановите его в конце (проверьте, что порт 8787 свободен) и перечислите в отчёте.
6. ДИСЦИПЛИНА СБОРКИ: после ЛЮБОЙ правки файлов в prototype/demo, prototype/engine, prototype/data выполните из ${ROOT}/prototype: node tools/build_manifest.mjs (иначе красными станут offline_inventory, build_manifest, pwa); перед сдачей — node tools/build_manifest.mjs --check.
7. Не делать git-коммитов. Писать только внутри ${ROOT}. Папки других проектов не читать. STATE.md, wiki/log.md, wiki/index.md и страницы wiki/ НЕ править (делает координатор), КРОМЕ случая, когда ваш пакет прямо называет вики-файл в touched_files. Документацию вашего пакета вносите в prototype/README.md (карта модулей и тестов, ограничения) и prototype/demo/README_ext.md.
8. ПЕРЕД НАЧАЛОМ сделайте снимок: из ${ROOT} node tools/snapshot.mjs --label wave3a3-<пакет>-before (он нужен проверяющему для additive_check).
9. Перед завершением прогоните по одному файлу все тестовые файлы, которые ваша правка могла затронуть (минимум: ext, ext_boot, wave1_integration, demo, settings, settings_boot, entry_boot, nav_focus, undo_all, data_pack, data_actions, forms, purity, g001.golden, g001, defaults_sync, build_manifest, offline_inventory, pwa, about, start_boot, debt-тесты FP-14, import-тесты FP-18, плюс ваши новые и профильные), перечислите числа в результате. Красное — исправить или честно сообщить в open_issues.
10. УРОКИ ПРОХОДОВ В НАСТОЯЩЕМ БРАУЗЕРЕ (заглушка DOM их не видит): хранилище (FP-05) после каждой записи просит ещё одну перерисовку страницы позже; если действие убирает нажатую кнопку (или заменяет узел), фокус падает на body и один возврат в микрозадаче или в setTimeout(0) не спасает. Для любого экрана с таким действием используйте готовый хранитель фокуса demo/focus_keep.mjs (create_focus_keeper: request(id) при записи, apply() в конце каждой отрисовки; образцы — settings.mjs, debt_edit.mjs, form_calendar.mjs). Ответ асинхронной работы (Worker, таймер, чтение файла) не должен перерисовывать замыкание отсоединённого узла — звать общий redraw/ctx.refresh. Нажатие кнопки в режиме «только чтение» (ctx.read_only() !== null) должно называть причину текстом ro.refused, а не кодом ошибки. Если в тесте нужна проверка в браузере, её делает координатор — вы браузер не запускаете.
11. Ответ — только структурированный объект по схеме.
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
  { id: 'FP-47', phase: 'FP-47 Хвосты', title: 'Хвосты волны 3а (повторный аудит): «Почему» у пяти чисел, круг CSV для метки и контрагента, таблицы словаря, build:gate, метки чисел G-001, «Обзор» при disabled, тест привязки резерва',
    spec: "ЗАДАЧА FP-47 (метка снимка wave3a3-fp47-before): хвосты волны 3а, найденные повторным аудитом 2026-10-24 (записи — " + ROOT + "/_ops/gap3/req-*.json, поля gaps и verify_note; сводка — _ops/gap3/summary.json; пакет — запись FP-47 в _ops/gap2/backlog-wave3.json). Сделайте семь независимых частей, каждую с тестом:\n(1) REQ-104: диалоги «Почему» вердикта, «можно потратить» и волны (demo/why_more.mjs, строки ~267, 284, 307 и scenarios.why_foot) должны показывать версию движка и номер расчёта c_… (как у чипа ассистента), а у «можно потратить» и волны — ещё и контрфакты («что было бы без…»), как у «почему» узкой точки. Тест на каждое из пяти чисел: версия, c_…, контрфакты (где требуется), сходимость суммы.\n(2) REQ-095: круг «экспорт Runway → мастер» восстанавливает метку (tag) и контрагента (counterparty): расширьте профиль runway-csv-1 (data/profiles/runway-csv-1.json и BUILTIN_PROFILES/RUNWAY_CSV_PROFILE — три копии должны совпадать, тест уже это проверяет) и разбор в demo/import_model.mjs ТОЛЬКО аддитивно; ячейки с ведущим апострофом (защита от формул) возвращаются без апострофа; account_id и kind файла по-прежнему не читаются (решение владельца) — назвать в тексте экрана. Обновите тест «ограничения круга» import_runway_csv.test.mjs стр. ~200–207 НАМЕРЕННО (метка и контрагент теперь возвращаются) и перечислите это в decisions.\n(3) REQ-114: tools/gen_vocab_tables.mjs получает режим --write (по умолчанию как раньше — только проверка и печать): он обновляет в wiki/product/* только размеченные блоки таблиц вердиктов и режимов между маркерами-комментариями (<!-- vocab:begin verdicts --> … <!-- vocab:end -->); введите маркеры в те страницы вики, где таблицы сейчас лежат (минимальная правка — только вставка маркеров вокруг существующих таблиц, текст таблиц не менять; страницы, названные в touched_files пакета, правка разрешена именно в этом объёме), --check после --write должен проходить.\n(4) REQ-178: prototype/package.json: npm run build (tools/build_manifest.mjs) не вызывает линтер слов; добавьте скрипт-обёртку build:gate = lint:words && build_manifest --check, а build оставьте как есть (манифест-дисциплина); в README и CHECKLIST-release.md — строка «перед релизом npm run build:gate»; тест check_script расширьте. Хук pre-commit и CI не трогать.\n(5) REQ-177: lint_vocab --coverage (режим, который перечисляет числа G-001 без метки num: на страницах вики; по умолчанию не включён, код выхода 0) и prototype/tools/suggest_num_labels.mjs (печатает предложения меток, ничего не пишет); не добавляйте метки в вики массово — только в страницы, где число G-001 приведено в таблице алгоритма, максимум 15 меток, каждая с golden-значением из tests/g001.golden.test.mjs; lint_vocab --registry должен остаться 0 ошибок.\n(6) REQ-067: таблица значений и график на «Обзоре» (demo/app.mjs chart/table; hooks минимальные), при отключённом налоговом правиле (rule_age disabled) не печатают ряд «свободно» и точки, зависящие от резервов: вместо них текст с датой reviewed_at (тот же гейт, что на «Резервах»); тест на настоящем app.mjs.\n(7) REQ-191: тест «после перевода суммы с операционного счёта на счёт, к которому привязан резерв, free не меняется» (критерий приёмки; transfer_guard.test проверяет только причину reserve_backed) — если поведение другое, опишите расхождение в open_issues, код движка не меняйте.\nОбщее: числа G-001 и golden не менять; браузер не запускать (проход делает координатор); фокус — только через demo/focus_keep.mjs; все новые строки RU и EN." },
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
Проверьте: (1) каждый критерий приёмки из backlog-wave3.json (запись ${it.id}) и из спецификации выполнен и доказан запущенным тестом — читайте тесты, ищите тавтологии, проверьте цифры независимым путём; (2) регрессии: перезапустите по одному файлу затронутые тесты и сравните с отчётом, golden G-001 и arith.lock зелёные; (3) аддитивность: из ${ROOT} node tools/additive_check.mjs <последний снимок с меткой wave3a3-${it.id.toLowerCase().replace('-', '')}-before из ${ROOT}/_backups> — ошибок «пропавший экспорт/файл» быть не должно; (4) node tools/build_manifest.mjs --check из prototype — актуален; (5) безопасность интерфейса (innerHTML, inline-стили, сеть, textContent), хранилища общего localhost только с префиксом runway, паритет RU/EN, lint_vocab и lint — 0 ошибок, нет запрещённых обещаний; (6) честность чисел и текстов; (7) краевые случаи и гонки (в том числе поздняя перерисовка: ответ асинхронной работы не должен перерисовывать отсоединённый узел; фокус после записи); (8) качество кода и документации; (9) порт 8787 свободен (серверы не оставлены). Вердикт accept — только если нет дефектов high/medium.`
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
Исправьте аддитивно, добавьте тест на каждый high/medium дефект, пересоберите манифест, перезапустите затронутые файлы по одному, верните объект результата (summary — что исправлено).`, { label: it.id + ' исправление', phase: it.phase, schema: IMPL_SCHEMA })
    if (fixed) {
      impl = fixed
      const again = await agent(CTX + `
РОЛЬ: ПОВТОРНАЯ ПРОВЕРКА «${it.id}». Были дефекты: ${JSON.stringify(verify.defects)}. Отчёт исправления: ${JSON.stringify(fixed)}. Убедитесь, что каждый high/medium закрыт тестом, затронутые файлы (по одному) зелёные, additive_check, lint_vocab, lint без ошибок, манифест актуален. Вердикт accept/defects.`, { label: it.id + ' повторная проверка', phase: it.phase, schema: VERIFY_SCHEMA })
      if (again) { verify = again; log(it.id + ' повторная проверка: ' + again.verdict + ', дефектов ' + again.defects.length) }
    }
  }
  results.push({ id: it.id, title: it.title, impl, verify })
}
return results
