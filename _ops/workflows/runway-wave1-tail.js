export const meta = {
  name: 'runway-wave1-tail',
  description: 'Runway: хвосты волны 1 по очереди — единая стопка «Отменить», порядок фокуса в навигации, слот waves.card; каждый с независимой проверкой',
  phases: [
    { title: 'S1.3 Отмена', detail: 'единая стопка Отменить/Вернуть для всех правок' },
    { title: 'S1.4 Навигация', detail: 'порядок фокуса = видимый порядок' },
    { title: 'S1.5 Карточка волны', detail: 'слот waves.card и кнопки на карточке' },
  ],
}

const ROOT = 'C:/xampp/htdocs/01/301/runway'

const CTX = `
КОНТЕКСТ. Проект «Runway» (${ROOT}) — прототип приложения-прогнозиста денежного потока: чистый JavaScript (ES-модули, без зависимостей, Node 24), движок prototype/engine, демо-страница prototype/demo (реестр расширений ext.mjs + пакеты pack_fp03..09.mjs), тесты prototype/tests (node --test). Пишите по-русски: комментарии, строки интерфейса, названия тестов; идентификаторы — snake_case как в коде. Прочитайте перед работой: ${ROOT}/STATE.md (блок «ТЕКУЩИЙ ШАГ»), ${ROOT}/prototype/README.md, ${ROOT}/prototype/demo/README_ext.md, а также сами файлы, которые вам предстоит менять.

ЖЁСТКИЕ ПРАВИЛА.
1. ТОЛЬКО АДДИТИВНО: не удалять и не ослаблять существующий код и тесты. Менять ожидание существующего теста можно, только если фича намеренно меняет поведение; каждое такое изменение перечислите в результате (поле decisions).
2. Безопасность интерфейса (CSP script-src 'self'; style-src 'self'): никаких innerHTML/outerHTML/eval/inline-стилей/обработчиков-строк/сети; текст пользователя в страницу — только через textContent (dom.mjs h()). В контекст ошибок пользовательские тексты не класть.
3. Строки интерфейса — RU и EN вместе, паритет ключей и плейсхолдеров (тесты TST-56 это проверяют; каждый ключ каталога должен использоваться литералом в коде пакета). Запрещённые формулировки (engine/vocab.json → forbidden_phrases, «безопасно», «гарантируем», «спокойно» как вердикт и т. п.) не писать; после работы запустить из ${ROOT}: node tools/lint_vocab.mjs — 0 ошибок. Налоговых и финансовых советов нет.
4. ПАМЯТЬ МАШИНЫ КРИТИЧЕСКИ МАЛА (7,8 ГБ, свободно ~0,4 ГБ; приложение уже дважды зависало). Запускайте РОВНО ОДИН процесс node за раз и только так, из ${ROOT}/prototype: node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs (один файл за раз). НИКОГДА не запускайте node --test без имени файла, не запускайте серверы и браузеры, не создавайте фоновых процессов. Тесты на время (TST-54 в timeline.test.mjs, REQ-153 в journal_log.test.mjs, «сложность» TST-45 в adversarial/verifier_io.test.mjs) на нагруженной машине падают — это не регресс, их не трогайте и не гоняйте без нужды.
5. Не делать git-коммитов. Писать только внутри ${ROOT}. Папки других проектов не читать. STATE.md, wiki/log.md и wiki/index.md НЕ править (это делает координатор). Если нужна документация — править prototype/README.md (карта модулей/тестов) и prototype/demo/README_ext.md в части вашей фичи.
6. Золотые числа G-001 (data/g001*.json, tests/g001.golden.test.mjs, tests/arith.lock.json, engine/vocab.json) не менять.
7. Перед завершением прогоните по одному файлу ВСЕ тестовые файлы, которые ваша правка могла затронуть (минимум: ext.test, ext_boot.test, entry.test, entry_boot.test, settings.test, settings_boot.test, demo.test, wave1_integration.test, as_of.test, scenario_builder.test, wave_edit.test, why_more.test, forms.test, data_pack.test, import_wizard.test, plus новые), и перечислите числа в результате. Если что-то красное — исправьте или честно сообщите в open_issues.
8. Ответ — только структурированный объект по схеме (summary, files_changed, files_created, tests, shared_files_touched, decisions, open_issues, acceptance).
`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    files_created: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, tests: { type: 'number' }, pass: { type: 'number' }, fail: { type: 'number' } }, required: ['file', 'tests', 'pass', 'fail'] } },
    shared_files_touched: { type: 'array', items: { type: 'string' } },
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
    extra_tests_created: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'defects', 'tests', 'notes'],
}

const ITEMS = [
  {
    id: 'S1.3',
    phase: 'S1.3 Отмена',
    title: 'Единая стопка «Отменить / Вернуть»',
    spec: `
ЗАДАЧА S1.3 — единая стопка «Отменить / Вернуть» (хвост приёмки волны 1: «стопка FP-04 не знает записей форм FP-08, мастера импорта FP-06 и правок FP-07»).

Сейчас: prototype/demo/undo.mjs — create_undo_stack(), diff_unit(before, after, meta) по корзинам UNDO_BUCKETS (facts, anchors, allocations, reserves), apply_unit(ws, unit, dir) с проверкой конфликта (undo_conflict), unit_label(meta, tr, money). Пакет pack_fp04.mjs записывает действие в стопку ДО ctx.set_ws (чтобы кнопки навигации, перерисованные внутри set_ws, уже видели новое состояние) и очищает стопку по событию ctx.subscribe с reason 'adopt' и 'restore'. ext.mjs: общий путь set_ws(ws, o) → host.set_ws → sync_journal → emit({reason, ws}) → host.render(); подписчики вызываются ДО перерисовки. Кнопки «Отменить»/«Вернуть» стоят в слоте nav.actions.

ЦЕЛЬ: «Отменить» откатывает ЛЮБОЕ действие пользователя, записанное общим путём ctx.set_ws / ctx.edit: формы FP-08 (платежи/правила, потоки часов, налоговые правила, накопления/резервы, курсы, счета, рассрочка, пропуск вхождения), настройки FP-03 (set_param — буфер, горизонт и т. д.; set_as_of — «Сегодня»; set_number_format), сценарии FP-07 (save_scenario/delete_scenario), правки волн (set_wave_override), добавление контрагента/покупки, а не только факты/якоря/аллокации/резервы FP-04.

Требования к дизайну (выберите надёжный вариант, обоснуйте в decisions):
 а) расширить events: ext.mjs emit(info) получает также before (рабочая область до записи) и meta (o.meta); ничего прежнего не ломать (старые подписчики игнорируют лишние поля);
 б) один пользовательский шаг = одна единица отмены (даже если затронуты несколько корзин); не должно быть двойной записи: действия FP-04, которые уже записывают единицу сами до set_ws, не должны попадать в стопку второй раз (придумайте надёжный признак, например o.undo === 'recorded', либо переведите FP-04 на единый путь с сохранением его публичного поведения и всех его тестов);
 в) расширить diff_unit/apply_unit: дополнительные корзины-массивы с id-полем (accounts/account_id, calendars/calendar_id, rules/rule_id, streams/stream_id, tax_rules — проверьте форму в ws и в ws_bridge/ws_edit, counterparties/counterparty_id, scenarios/scenario_id, purchases/purchase_id, debts/debt_id, rates/fx_id, wave_overrides/override_id (учтите служебное поле seq), plans/plan_id, составной ключ overrides — обработайте или явно исключите с обоснованием), а также «слоты-объекты»: params (по ключу параметра, включая значение null и отсутствие ключа) и метаполя верхнего уровня ws (as_of, number_format, name, locale, decision_currency и прочие не-корзинные поля, см. ws_bridge.meta_of). Для старых четырёх корзин поведение и формат единицы не менять (тесты entry/undo должны остаться зелёными);
 г) НЕ записывать в стопку: reason 'undo'/'redo' (сами себя), 'adopt', 'restore' (замена набора целиком — стопка очищается, как сейчас), записи мастера импорта FP-06 (у него свой «Откатить партию» с реестром партий; найдите, какие reason он использует в pack_fp06.mjs/import_wizard.mjs/import_model.mjs, и исключите их по списку; при этом их применение не должно ломать стопку: после импорта прежние единицы либо остаются валидными, либо дают честный undo_conflict), загрузку набора данных. Документируйте список исключений в коде константой;
 д) подпись кнопок и сообщений: расширить unit_label новыми видами (settings, today, rule, stream, tax_rule, reserve (если нет), account, rate, scenario, wave_override, other…), строки в demo/i18n/entry.mjs RU+EN, паритет плейсхолдеров; общая подпись для неизвестного вида остаётся;
 е) лимит UNDO_LIMIT = 50 и семантика конфликтов (undo_conflict снимает единицу без записи) сохраняются; «Вернуть» очищается новым действием;
 ж) журнал остаётся append-only: отмена идёт через ctx.set_ws → sync_journal (revert/supersedes), state_hash после отмены равен хэшу до действия на тех корзинах, где это было раньше (не ухудшать).
Новые тесты — в НОВОМ файле prototype/tests/undo_all.test.mjs (метки TST-16, REQ-090 в названиях): по каждому виду правки (set_param буфер, set_as_of, set_number_format, upsert_rule+delete_rule, upsert_stream, upsert_tax_rule, upsert_reserve, upsert_account, upsert_fx_rate, save_scenario/delete_scenario, set_wave_override, add_counterparty, добавление/удаление факта) — отмена и возврат восстанавливают рабочую область побайтно (canon) и inputs_hash; многокорзинная правка — одна единица; конфликт при постороннем изменении; исключённые reason не пишутся в стопку; двойной записи нет (один «+ Факт» = одна единица); лимит 50; кнопки навигации в настоящем app.mjs на заглушке DOM (по образцу tests/entry_boot.test.mjs): доступность, подпись aria-label RU и EN. Обновить prototype/README.md (карта) и demo/README_ext.md (описание: что пишется в стопку, список исключений, признак «уже записано»).
`,
  },
  {
    id: 'S1.4',
    phase: 'S1.4 Навигация',
    title: 'Порядок фокуса в навигации',
    spec: `
ЗАДАЧА S1.4 — порядок фокуса клавиатуры в навигации совпадает с видимым порядком (WCAG 2.4.3, замечание из проверки в браузере).

Сейчас: prototype/demo/app.mjs render_nav() рисует <ul> со ссылками разделов (li > a) и затем li.nav-action с кнопками из слота nav.actions («+ Факт», «Сверить остаток», «Отменить», «Вернуть», «?»). В prototype/demo/style.css на ширине ≥ 1024 px действует правило .nav .nav-action { order: -1 } (кнопки действий визуально первыми, в DOM последними) и .nav ul { max-height: 100vh; overflow-y: auto } — из-за этого порядок Tab не совпадает с видимым. На узких экранах (<600 px) навигация — нижняя фиксированная панель (ссылки в строку), 600–1023 px — горизонтальная полоса.
ЦЕЛЬ: убрать расхождение без потери удобства: на широком окне кнопки действий должны оставаться видимыми без прокрутки списка из 18 разделов, но порядок в DOM = порядок на экране на ВСЕХ ширинах (никакого CSS order на элементах навигации). Рекомендация: на ≥1024 px сделать .nav колонкой (flex): список ссылок — прокручиваемая часть (flex: 1 1 auto; overflow-y: auto), блок действий — закреплён внизу панели (position: sticky; bottom: 0 или отдельная ячейка колонки), либо наоборот действия сверху, если DOM-порядок действий-первыми не ломает узкие раскладки; выберите и обоснуйте. Класс li.nav-action и положение действий внутри #nav сохранить (тесты ext_boot/entry_boot/settings_boot/anchor и др. ищут их так); при необходимости разделить на два <ul> с aria-label у каждого (например «Разделы» и «Действия») — допустимо, если все существующие тесты остаются зелёными.
Требования: фокус-индикатор виден (не обрезан overflow), skip-link «К содержимому» и aria-current сохраняются, цели касания не меньше текущих, тёмная и светлая темы не ломаются, нет inline-стилей. Тесты: новый файл prototype/tests/nav_focus.test.mjs — статически (чтение style.css: нет order на .nav и .nav-action ни в одном медиа-запросе; нет position:fixed/absolute, скрывающих действия), в настоящем app.mjs на заглушке DOM (по образцу entry_boot.test.mjs): порядок узлов навигации в DOM — разделы затем действия (или как выбрано), все кнопки и ссылки достижимы (нет tabindex=-1, нет disabled без причины), aria-label у списков. Обновить prototype/README.md (раздел демо) кратко.
`,
  },
  {
    id: 'S1.5',
    phase: 'S1.5 Карточка волны',
    title: 'Слот waves.card',
    spec: `
ЗАДАЧА S1.5 — слот реестра waves.card: кнопки правок и «почему» прямо на карточке волны (хвост приёмки волны 1, FP-07 №1.3: «слот waves.card не добавлен»).

Сейчас: экран «Волны» (app.mjs view_waves) рисует карточки волн; пакет FP-07 (pack_fp07.mjs, wave_edit.mjs, why_more.mjs) подключается через слот waves.actions (действия над волнами отдельным блоком) и хук show_why. Список слотов — ext.mjs SLOTS (замороженный список; его проверяют tests/ext.test.mjs и README_ext.md).
ЦЕЛЬ: добавить слот waves.card (ext.mjs SLOTS) с контекстом карточки: renderer получает (ctx, card) где card = { wave, mode, index } (волна из движка list_waves_ex: поля как в app.mjs; режим 'plan'|'worse'; индекс в списке). app.mjs view_waves вызывает ext.slot_nodes('waves.card', ...) для КАЖДОЙ карточки и добавляет узлы в конец карточки (минимальная правка: не больше ~25 строк хуков). Пакет FP-07 регистрирует в слоте компактные кнопки для карточки: «Почему так» (открывает существующий диалог/блок «почему» для этой волны) и «Править волну» (существующие операции merge/split/pin из wave_edit.mjs — переиспользовать готовые функции и диалоги, не дублировать логику). Старый слот waves.actions и всё его поведение сохранить. Идентификаторы DOM на странице должны оставаться уникальными (id кнопок включают индекс/режим волны), у каждой кнопки aria-label с названием/датой волны, текстовая альтернатива цвету (TST-58).
Если реестр слотов проверяет контекст render через ctx (slot_nodes(slot, c)), убедитесь, что передача карточки не ломает существующие слоты (у них один аргумент). Тесты: новый файл prototype/tests/waves_card.test.mjs (метки TST-37, REQ-036, REQ-104): слот зарегистрирован, карточка получает волну/режим/индекс, кнопки есть на каждой карточке в обоих режимах, действия вызывают те же правки (set_wave_override через ctx.edit), «почему» показывает цепочку с суммой = просадке (как в why_more.test.mjs), падение рендера одного блока не ломает карточку (safe в ext), RU/EN. Обновить ext.test.mjs ТОЛЬКО в части списка слотов (добавить waves.card), demo/README_ext.md (таблица слотов, контекст), prototype/README.md (строка про слоты).
`,
  },
]

const results = []
for (const it of ITEMS) {
  phase(it.phase)
  log('Начинаю ' + it.id + ': ' + it.title)
  const impl_prompt = CTX + '\n' + it.spec
  let impl = await agent(impl_prompt, { label: it.id + ' реализация', phase: it.phase, schema: IMPL_SCHEMA })
  if (!impl) { log(it.id + ': реализация не вернула результат'); results.push({ id: it.id, impl: null, verify: null }); continue }
  log(it.id + ' реализация: ' + impl.summary.slice(0, 200))

  const verify_prompt = CTX + `
РОЛЬ: НЕЗАВИСИМЫЙ ПРОВЕРЯЮЩИЙ (состязательный). Другой агент только что реализовал «${it.id} — ${it.title}». Ваша задача — найти реальные дефекты, а не одобрить. Вы НЕ переписываете реализацию; вы можете добавлять свои тесты в НОВЫЙ файл prototype/tests/${it.id.toLowerCase().replace('.', '_')}_adv.test.mjs (аддитивно) и запускать существующие.
Спецификация, по которой работал реализатор:
${it.spec}
Отчёт реализатора (JSON): ${JSON.stringify(impl)}
Проверьте: (1) каждый критерий приёмки из спецификации выполнен и доказан запущенным тестом (прочитайте тесты, а не только отчёт; убедитесь, что тесты не тавтологичны); (2) нет регрессий: перезапустите по одному файлу все затронутые тестовые файлы из правила 7 и сравните с отчётом; (3) аддитивность: node tools/additive_check.mjs _backups/${'2026-10-06_041905_checkpoint-42-S1-asof-done-lab-caveat-untested'} (запускать из ${ROOT}) — ошибок «пропавший экспорт/файл» быть не должно; предупреждения о переименованных тестах перечислите; (4) безопасность интерфейса (нет innerHTML, inline-стилей, сети; текст через textContent), паритет RU/EN, lint_vocab 0 ошибок, node tools/lint.mjs 0 ошибок; (5) краевые случаи и гонки (двойная запись, устаревшие данные, исключённые причины, пустые наборы, режимы plan/worse, RU/EN, наборы G-001 low/gap/late); (6) качество кода: не дублирует логику, комментарии по-русски, согласованность с соседним кодом. Вердикт 'accept' — только если нет дефектов уровня high/medium; иначе 'defects' со списком (где, как воспроизвести, как исправить).`
  let verify = await agent(verify_prompt, { label: it.id + ' проверка', phase: it.phase, schema: VERIFY_SCHEMA })
  if (verify) log(it.id + ' проверка: ' + verify.verdict + ', дефектов ' + verify.defects.length)

  const serious = verify ? verify.defects.filter((d) => d.severity === 'high' || d.severity === 'medium') : []
  if (verify && verify.verdict === 'defects' && serious.length > 0) {
    log(it.id + ': исправляю ' + serious.length + ' дефект(ов)')
    const fix_prompt = CTX + `
РОЛЬ: ИСПРАВЛЕНИЕ ДЕФЕКТОВ после независимой проверки. Исходная задача:
${it.spec}
Что уже сделано (JSON): ${JSON.stringify(impl)}
Найденные дефекты (high/medium — исправить обязательно, low — по возможности): ${JSON.stringify(verify.defects)}
Исправьте аддитивно, добавьте тесты на каждый исправленный дефект (в файлы реализации или новый файл), перезапустите по одному файлу затронутые тесты и верните тот же объект результата (summary — что исправлено).`
    const fixed = await agent(fix_prompt, { label: it.id + ' исправление', phase: it.phase, schema: IMPL_SCHEMA })
    if (fixed) {
      impl = fixed
      const re_prompt = CTX + `
РОЛЬ: ПОВТОРНАЯ ПРОВЕРКА «${it.id}» после исправлений. Дефекты, которые были найдены: ${JSON.stringify(verify.defects)}. Отчёт исправления: ${JSON.stringify(fixed)}. Убедитесь, что каждый high/medium дефект закрыт тестом, затронутые тестовые файлы (по одному) зелёные, additive_check без ошибок, lint_vocab и lint без ошибок. Вердикт accept/defects.`
      const again = await agent(re_prompt, { label: it.id + ' повторная проверка', phase: it.phase, schema: VERIFY_SCHEMA })
      if (again) { verify = again; log(it.id + ' повторная проверка: ' + again.verdict + ', дефектов ' + again.defects.length) }
    }
  }
  results.push({ id: it.id, title: it.title, impl, verify })
}
return results
