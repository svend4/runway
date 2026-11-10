export const meta = {
  name: 'runway-s15-finish',
  description: 'Runway S1.5: достроить слот waves.card после обрыва (3 красных теста), затем независимая проверка',
  phases: [{ title: 'Доработка S1.5' }, { title: 'Проверка S1.5' }],
}

const ROOT = 'C:/xampp/htdocs/01/301/runway'

const CTX = `
КОНТЕКСТ. Проект «Runway» (${ROOT}) — прототип приложения-прогнозиста денежного потока: чистый JavaScript (ES-модули, без зависимостей, Node 24), движок prototype/engine, демо prototype/demo (реестр расширений ext.mjs + пакеты pack_fp03..09.mjs), тесты prototype/tests (node --test). Пишите по-русски (комментарии, строки интерфейса, названия тестов); идентификаторы — snake_case. Прочитайте: ${ROOT}/STATE.md (блок «ТЕКУЩИЙ ШАГ»), ${ROOT}/prototype/README.md, ${ROOT}/prototype/demo/README_ext.md и файлы, которые правите.

ЖЁСТКИЕ ПРАВИЛА.
1. ТОЛЬКО АДДИТИВНО: не удалять и не ослаблять существующий код и тесты; менять ожидание существующего теста можно, только если фича намеренно меняет поведение — перечислите такие изменения в decisions.
2. Безопасность интерфейса (CSP script-src 'self'; style-src 'self'): никаких innerHTML/outerHTML/eval/inline-стилей/обработчиков-строк/сети; текст пользователя — только через textContent (dom.mjs h()); пользовательские тексты в контекст ошибок не класть.
3. Строки интерфейса — RU и EN, паритет ключей и плейсхолдеров (тесты TST-56); каждый ключ каталога используется литералом в коде. Запрещённые формулировки (engine/vocab.json → forbidden_phrases, «безопасно», «гарантируем», «спокойно» как вердикт) не писать; после работы из ${ROOT}: node tools/lint_vocab.mjs — 0 ошибок; node tools/lint.mjs — 0 ошибок.
4. ПАМЯТЬ МАШИНЫ КРИТИЧЕСКИ МАЛА (7,8 ГБ, свободно ~0,5 ГБ; приложение уже зависало несколько раз). РОВНО ОДИН процесс node за раз, только из ${ROOT}/prototype: node --test --test-timeout=240000 --test-concurrency=1 tests/<файл>.test.mjs (один файл за раз). НИКОГДА не запускайте node --test без имени файла, серверы, браузеры, фоновые процессы. Тесты на время (TST-54 timeline, REQ-153 journal_log, «сложность» TST-45 в adversarial/verifier_io) не гонять.
5. Не делать git-коммитов; писать только внутри ${ROOT}; папки других проектов не читать. STATE.md, wiki/log.md, wiki/index.md НЕ править.
6. Золотые данные G-001 (data/g001*.json, tests/g001.golden.test.mjs, tests/arith.lock.json, engine/vocab.json) не менять.
7. Ответ — только структурированный объект по схеме.
`

const IMPL = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    files_created: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, tests: { type: 'number' }, pass: { type: 'number' }, fail: { type: 'number' } }, required: ['file', 'tests', 'pass', 'fail'] } },
    decisions: { type: 'array', items: { type: 'string' } },
    open_issues: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['criterion', 'met', 'evidence'] } },
  },
  required: ['summary', 'files_changed', 'files_created', 'tests', 'decisions', 'open_issues', 'acceptance'],
}
const VERIFY = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'defects'] },
    defects: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, where: { type: 'string' }, repro: { type: 'string' }, suggested_fix: { type: 'string' } }, required: ['severity', 'title', 'where', 'repro'] } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, tests: { type: 'number' }, pass: { type: 'number' }, fail: { type: 'number' } }, required: ['file', 'tests', 'pass', 'fail'] } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'defects', 'tests', 'notes'],
}

const SPEC = `
ЗАДАЧА S1.5 — слот реестра waves.card: кнопки «Почему так» и «Править волну» прямо на карточке волны.
Исходная постановка: в ext.mjs добавлен слот waves.card (список SLOTS); renderer получает (ctx, card) где card = { wave, mode, index }; app.mjs view_waves вызывает ext.slot_nodes('waves.card', …) для КАЖДОЙ карточки и добавляет узлы в её конец (минимальная правка); пакет FP-07 (pack_fp07.mjs + wave_edit.mjs + why_more.mjs) регистрирует в слоте компактные кнопки «Почему так» (существующий диалог/блок «почему» для этой волны) и «Править волну» (существующие merge/split/pin из wave_edit.mjs — переиспользовать, не дублировать). Старый слот waves.actions и его поведение сохранены. DOM-идентификаторы уникальны (id включают режим и индекс волны), у кнопок aria-label с названием/датой волны, текстовая альтернатива цвету. Слоты с одним аргументом (render(ctx)) продолжают работать.

СОСТОЯНИЕ ПОСЛЕ ОБРЫВА (приложение зависло, предыдущий агент не завершил работу): на диске уже есть правки prototype/demo/ext.mjs, app.mjs, wave_edit.mjs, pack_fp07.mjs, i18n/scenarios.mjs, css/scenarios.css, tests/ext.test.mjs и НОВЫЙ prototype/tests/waves_card.test.mjs (22 теста). Проверено перед вами: tests/ext.test.mjs 17/17 и tests/wave_edit.test.mjs 12/12 зелёные; tests/waves_card.test.mjs — 19 из 22, красные три:
 1) «REQ-036 render слота waves.card получает (ctx, card); у остальных слотов render по-прежнему получает один аргумент; ctx по умолчанию — общий» (падает за <1 мс — вероятно исключение/неверное предположение теста о API ext);
 2) «TST-37 REQ-036 «Править волну»: диалог с объединением, разделением и закреплением…» — не совпал текст карточки с регэкспом /Волна 1 · 23 окт – 25 окт · платежей 3 · 1\\s520,00\\s€/ (проверьте реальный текст карточки волны в app.mjs и формат дат/денег: ожидание теста или код неверны — исправьте то, что неверно, не подгоняя вслепую);
 3) «REQ-036 падение сторонних блоков слота waves.card не ломает карточку…» — assert «plan: по одному сбою на карточку» (число сбоев в диагностике ext не такое, как ожидал тест; разберитесь, как ext.diagnostics() считает сбои слота, и приведите в соответствие тест или код).
Ваша задача: ДОВЕСТИ S1.5 ДО КОНЦА — разобрать причину каждого красного теста, исправить (код или ожидание — по существу, без ослабления смысла проверки), убедиться, что вся фича соответствует постановке (прочитайте diff логики: ext.mjs, app.mjs view_waves, pack_fp07.mjs, wave_edit.mjs, i18n/scenarios.mjs, css/scenarios.css), дописать недостающее (README_ext.md: таблица слотов и контекст waves.card; prototype/README.md: строка про слоты и тесты), затем по одному файлу прогнать: waves_card, ext, ext_boot, wave_edit, why_more, wave1_integration, scenario_builder, demo, entry_boot, settings_boot, nav_focus, undo_all, forms, data_pack (и числа указать в результате).
`

phase('Доработка S1.5')
const fin = await agent(CTX + SPEC, { label: 'S1.5 доработка', phase: 'Доработка S1.5', schema: IMPL })
if (!fin) { log('S1.5: доработка не вернула результат'); return { fin: null, verify: null } }
log('S1.5 доработка: ' + fin.summary.slice(0, 300))

phase('Проверка S1.5')
const VP = CTX + `
РОЛЬ: НЕЗАВИСИМЫЙ ПРОВЕРЯЮЩИЙ (состязательный). Реализация «S1.5 — слот waves.card» только что доработана другим агентом. Найдите реальные дефекты, а не одобряйте. Вы НЕ переписываете реализацию; можете добавить свои тесты в НОВЫЙ файл prototype/tests/s1_5_adv.test.mjs и запускать существующие (по одному).
Постановка и состояние: ${SPEC}
Отчёт доработки (JSON): ${JSON.stringify(fin)}
Проверьте: (1) каждый критерий постановки выполнен и доказан запущенным тестом — читайте сами тесты, ищите тавтологии; (2) регрессии: перезапустите по одному файлу waves_card, ext, ext_boot, wave_edit, why_more, wave1_integration, scenario_builder, demo, entry_boot, settings_boot, nav_focus, undo_all, undo_fix, s1_3_adv, s1_4_adv, forms, data_pack, as_of; (3) аддитивность: из ${ROOT}: node tools/additive_check.mjs _backups/2026-10-06_100522_checkpoint-43-after-crash-S13-S14-done-S15-partial — ошибок «пропавший экспорт/файл» быть не должно (предупреждения о переименованных тестах перечислите); (4) безопасность интерфейса (innerHTML, inline-стили, сеть, textContent), паритет RU/EN, lint_vocab и lint — 0 ошибок; (5) краевые случаи: пустой список волн, режимы plan/worse, наборы G-001 low/gap/late, падение стороннего блока слота, одинаковые даты у двух волн (уникальность id), одноаргументные слоты; (6) качество: нет дублирования логики wave_edit/why_more, комментарии по-русски. Вердикт accept — только если нет дефектов high/medium.`
let verify = await agent(VP, { label: 'S1.5 проверка', phase: 'Проверка S1.5', schema: VERIFY })
if (verify) log('S1.5 проверка: ' + verify.verdict + ', дефектов ' + verify.defects.length)
const serious = verify ? verify.defects.filter((d) => d.severity !== 'low') : []
let fixed = null
if (verify && serious.length > 0) {
  fixed = await agent(CTX + `РОЛЬ: ИСПРАВЛЕНИЕ ДЕФЕКТОВ S1.5 после независимой проверки.\n${SPEC}\nЧто сделано: ${JSON.stringify(fin)}\nДефекты: ${JSON.stringify(verify.defects)}\nИсправьте аддитивно, добавьте тест на каждый high/medium дефект, перезапустите затронутые файлы по одному, верните объект результата.`, { label: 'S1.5 исправление', phase: 'Проверка S1.5', schema: IMPL })
  if (fixed) {
    const again = await agent(CTX + `РОЛЬ: ПОВТОРНАЯ ПРОВЕРКА S1.5. Дефекты были: ${JSON.stringify(verify.defects)}. Отчёт исправления: ${JSON.stringify(fixed)}. Убедитесь, что каждый high/medium дефект закрыт тестом, затронутые файлы (по одному) зелёные, additive_check, lint_vocab, lint без ошибок. Вердикт accept/defects.`, { label: 'S1.5 повторная проверка', phase: 'Проверка S1.5', schema: VERIFY })
    if (again) verify = again
  }
}
return { fin, verify, fixed }
