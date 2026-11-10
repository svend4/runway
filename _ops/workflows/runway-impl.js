export const meta = {
  name: 'runway-impl',
  description: 'Реализация Волны 1 (FP-01…FP-09) аддитивно: фаза A — каркас+движок, B — 6 пакетов параллельно, C — формы данных + интегратор. Запуск: args {phase: "A"|"B"|"C"}',
  phases: [
    { title: 'A', detail: 'FP-01 каркас расширений и мост журнал↔ws ∥ FP-02 укрепление движка' },
    { title: 'B', detail: 'FP-03 настройки · FP-04 ввод · FP-05 хранение · FP-06 импорт · FP-07 сценарии · FP-09 витрины' },
    { title: 'C', detail: 'FP-08 формы данных → интегратор (полный прогон, хуки app.mjs)' },
  ],
}

const ROOT = 'C:\\xampp\\htdocs\\01\\301\\runway'
const W = ROOT + '\\wiki'
const OPS = ROOT + '\\_ops'
const P = ROOT + '\\prototype'
const PHASE = (args && args.phase) || 'A'

const COMMON = [
  'Ты — инженер проекта «Runway»: исполняемый прототип детерминированного движка прогноза денежного потока (чистый JavaScript, ES modules, БЕЗ зависимостей, Node 24, тесты node --test) и демо-страница на нём. Сегодня 2026-10-05. Рабочая папка: ' + ROOT + '; код — ' + P + '. Комментарии и сообщения тестов — по-русски; идентификаторы — snake_case как в каноне.',
  'КОНТЕКСТ. Аудит (' + W + '\\product\\18-implementation-gap-analysis.md и ' + OPS + '\\gap\\*) показал: движок и тесты зрелые (1098 тестов, 1084 pass, 0 fail, 13 todo, 1 skip), а демо только ЧИТАЕТ: нет ввода данных, хранения, сверки, UI импорта/экспорта. Мы дописываем возможности «Волны 1» (feature packs FP-01…FP-09).',
  '',
  'ЧИТАЙ ПЕРЕД РАБОТОЙ: (1) ' + ROOT + '\\CLAUDE.md; (2) твою запись в ' + OPS + '\\gap\\backlog.json — распечатай ТОЛЬКО её: node -e "const b=require(\'' + (OPS + '\\gap\\backlog.json').replace(/\\/g, '/') + '\');console.log(JSON.stringify(b.find(x=>x.id===\'FP-NN\'),null,1))" (подставь свой FP-NN); (3) раздел твоего pack в ' + W + '\\product\\18-implementation-gap-analysis.md (Grep по «FP-NN»); (4) блоки REQ твоего pack в ' + W + '\\product\\02-requirements.md (файл огромный — только Grep по REQ-ID и чтение блока); (5) ' + P + '\\README.md и ' + W + '\\product\\15-prototype-guide.md (структура и правила кода); (6) design-brief ' + OPS + '\\design-brief.md — только нужные разделы (§2 определения, §3 модель, §4 соглашения, §10 запреты, §12–§14 решения; ' + OPS + '\\canon-decisions.md — «Финальные сигнатуры»).',
  '',
  'ГЛАВНЫЕ ПРАВИЛА',
  '1. АДДИТИВНО. Не удаляй и не переименовывай существующие экспорты, функции, тесты; не сокращай код. Существующие файлы только ДОПОЛНЯЙ (новые функции, ветки, проверки). Изменение поведения существующего — только если этого требует критерий приёмки, и обязательно перечисли в notes. Ни один существующий тест не должен быть ослаблен (допустимо ТОЛЬКО снять test.todo/skip, когда дефект закрыт).',
  '2. ВЛАДЕНИЕ ФАЙЛАМИ. Пиши новые файлы из new_files своего FP и правь только touched_files своего FP. Общие файлы (prototype/demo/app.mjs, demo/i18n.mjs, demo/index.html, demo/style.css, tests/demo.test.mjs) правит ТОЛЬКО FP-01 (хуки) и интегратор фазы C. Нужен новый хук/правка общего файла — запиши запрос в ' + OPS + '\\impl\\hook-requests-FPNN.md (папку создай), сам не правь.',
  '3. ДВИЖОК ЧИСТЫЙ: в engine/ никаких Date, Date.now, Math.random, fetch, process, node:*, localStorage (порты — аргументы). Правило слоёв: purity.test.mjs и design-brief §14 B4. UI-модули (demo/) — DOM-код отделяй от чистых «моделей» (они тестируются в Node без DOM). Новые пакеты UI регистрируются через ext.mjs (создаёт FP-01); точка входа pack — demo/pack_fpNN.mjs с экспортом register(ext).',
  '4. БЕЗОПАСНОСТЬ UI: сервер отдаёт CSP script-src \'self\'; style-src \'self\' — запрещены inline style-атрибуты в разметке (setAttribute(\'style\')), inline-обработчики, eval/new Function, внешние URL/CDN, innerHTML с пользовательским текстом (только textContent/узлы). JSON из файла — недоверенные данные (ключи __proto__/constructor/prototype). Секреты и персональные данные в логи не писать.',
  '5. ТОН И ЗАПРЕТЫ: design-brief §10; node ' + ROOT + '\\tools\\lint_vocab.mjs должен давать 0 ошибок для твоих файлов; налоги — «расчёт по введённым правилам, не консультация»; вердикты OK/TIGHT/FRAGILE/NO (RU: выдерживает/впритык/хрупко/не хватает).',
  '6. i18n: ключи <pack>.<имя> в demo/i18n/<pack>.mjs вида export default { ru: {…}, en: {…} } (формат уточни по demo/ext.mjs после FP-01); паритет RU/EN и плейсхолдеров, без мёртвых ключей (TST-56).',
  '7. ТЕСТЫ: node:test, названия содержат TST-NN/REQ-NNN из критериев приёмки. Запускай ТОЛЬКО свои тесты + tests/purity.test.mjs + tests/demo.test.mjs (весь набор запускает интегратор; тест TST-54 по производительности чувствителен к нагрузке машины — при единичном падении перезапусти отдельно).',
  '8. КРИТЕРИИ ПРИЁМКИ из бэклога — выполни ВСЕ. В отчёте по каждому: met / partial / unmet + доказательство (файл, тест). Не выдавай «met» без запуска теста. Что невыполнимо без решения владельца — partial с объяснением.',
  '9. Не запускай серверов и фоновых процессов; браузер не используй (он общий). Не трогай wiki/*, raw/*, design-brief, canon-decisions (их обновит координатор). Python в среде — заглушка Windows: правки файлов делай Edit/Write или node-скриптами.',
  '10. Отчёт верни по схеме. Файлы должны быть записаны, тесты запущены ДО отчёта.',
].join('\n')

const SCHEMA = {
  type: 'object',
  properties: {
    fp: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: 'созданные/изменённые файлы' },
    tests_total: { type: 'integer', description: 'сколько тестов в запущенных тобой файлах' },
    tests_pass: { type: 'integer' },
    acceptance: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'string' }, status: { type: 'string', enum: ['met', 'partial', 'unmet'] }, evidence: { type: 'string' } },
        required: ['criterion', 'status', 'evidence'],
      },
    },
    hook_requests: { type: 'array', items: { type: 'string' }, description: 'запросы на правки общих файлов (также в _ops/impl/hook-requests-FPNN.md)' },
    notes: { type: 'array', items: { type: 'string' }, description: 'важное: изменения поведения существующего кода, допущения, проблемы канона' },
  },
  required: ['fp', 'files', 'tests_total', 'tests_pass', 'acceptance', 'notes'],
}

async function ag(prompt, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await agent(prompt, attempt === 1 ? opts : { ...opts, label: opts.label + '#' + attempt })
    if (r) return r
    log('Нет результата у ' + opts.label + ' (попытка ' + attempt + '/3)')
  }
  return null
}
const pack = (fp, title, extra, effort) => ag(
  [COMMON, '', '=== ТВОЁ ЗАДАНИЕ: ' + fp + ' — ' + title + ' ===', 'Твой FP-NN = ' + fp + '. ' + extra].join('\n'),
  { label: fp, phase: PHASE, schema: SCHEMA, effort: effort || 'high' }
)

const PACK_NOTE = 'Перед началом ПРОЧИТАЙ код каркаса, который написал FP-01: ' + P + '\\demo\\ext.mjs (реестр: регистрация экранов/слотов/хуков/каталогов i18n), ws_edit.mjs (правки рабочей копии, коды ошибок), ws_bridge.mjs (журнал↔ws), journal_log.mjs, ids.mjs, dom.mjs и ' + P + '\\demo\\README_ext.md (если есть). Твой pack подключается ТОЛЬКО через demo/pack_fpNN.mjs → register(ext); manifest уже перечисляет pack_fp03…fp09 (отсутствующий файл не ломает загрузку).'

phase(PHASE)
let results = []

if (PHASE === 'A') {
  results = await parallel([
    () => pack('FP-01', 'каркас записи и расширений: правка рабочей копии, мост журнал↔рабочая область, реестр экранов',
      [
        'Ты — единственный, кто правит demo/app.mjs (ТОЛЬКО хуки, ≤ 40 строк), demo/i18n.mjs (одна точка слияния каталогов), demo/index.html, tests/demo.test.mjs (список ожидаемых импортов). Новые файлы: demo/ext.mjs (реестр), demo/dom.mjs, demo/ws_edit.mjs, demo/ws_bridge.mjs, demo/ids.mjs, demo/journal_log.mjs, demo/ext_manifest.mjs, demo/README_ext.md, tests/ext.test.mjs, tests/ws_edit.test.mjs, tests/ws_bridge.test.mjs.',
        'ОБЯЗАТЕЛЬНЫЙ ДИЗАЙН КАРКАСА (от него зависят 7 параллельных агентов фазы B — делай стабильно и документируй в demo/README_ext.md):',
        '- ext.mjs: register_view({id, title_key, order, render(ctx) → Node}) — новый экран в навигации; register_slot_item(slot, {id, order, render(ctx) → Node}) для слотов overview.cards, reserves.sections, data.sections, waves.actions, nav.actions (кнопка «+»), assistant.extras; register_hook(name, fn) для scenario_ops, show_why, boot; register_i18n(pack, {ru, en}); ensure_css(href). ctx: {get_ws(), set_ws(ws, {reason}), get_model(), subscribe(fn), tr(key, params), fmt(), lang(), mode(), notify(msg, kind), journal}. Реестр tolerant: падение одного pack не ломает приложение (try/catch + notify).',
        '- ext_manifest.mjs: список пакетов по имени demo/pack_fp03.mjs … pack_fp09.mjs (FP-08 тоже: pack_fp08.mjs), загрузка динамическим import() в try/catch; отсутствие файла — норма.',
        '- ws_edit.mjs (ЧИСТЫЕ функции, без DOM): apply_edit(ws, edit) → {ok, ws, error?} (новый объект, исходный не мутируется; ошибки кодами канона E_*; ключи __proto__/constructor отвергаются); словарь правок (расширяемый регистром register_edit(type, fn)): add_fact, void_fact (отмена), set_anchor, set_param, upsert_account, upsert_rule, delete_rule, upsert_stream, upsert_tax_rule, upsert_reserve, record_allocation, upsert_fx_rate, add_purchase, save_scenario, delete_scenario, set_wave_override, add_counterparty; валидация модели (transfer-ноги суммируются в 0 в одной валюте, E_FUTURE_POSTED для posted в будущем, единое пространство Id rule_id/stream_id и др. — по 8 кодам REQ-017); негативный тест на каждый код.',
        '- ws_bridge.mjs: ws_to_events(ws) и events_to_ws(events, base?) (использует engine/ledger.mjs: make_event, effective_events, reduce — расхождение формы ws (массивы) и State (словари по id) закрой преобразователями); journal_log.mjs: append-only журнал с монотонным seq, префиксным хэшем, снимком и хвостом (fold(снимок, хвост) = свёртке всего журнала). ids.mjs: генератор идентификаторов (uuidv7-подобный) с внедряемыми портами часов и ГПСЧ.',
        '- Ограничение app.mjs: добавь ТОЛЬКО хуки (навигация из реестра + маршрут для зарегистрированных экранов + слоты + вызов boot-хука + общий путь «ws изменился → recompute → render»). Существующее поведение и все 1098 тестов должны сохраниться. Расширь tests/demo.test.mjs так, чтобы проверки TST-56 (паритет i18n, мёртвые ключи, запрещённые слова) и «все импорты разрешаются» охватывали demo/*.mjs и demo/i18n/*.mjs, а не только app.mjs/i18n.mjs.',
        'Приёмка — по записи FP-01 в backlog.json (TST-38 REQ-094 ws→журнал→ws на 4 наборах; TST-16 REQ-012 fold на ≥ 10^3 случайных журналах с seed; REQ-017 негативные тесты; REQ-153 36 500 записей ≤ 2 с).',
      ].join('\n'), 'high'),
    () => pack('FP-02', 'движок: закрытие P0-хвостов и устойчивость к чужому файлу',
      [
        'Ты правишь СУЩЕСТВУЮЩИЕ модули engine/ (fx, timeline, verifier, io, sinking, recurrence, calibration, backtest, ledger) — ТОЛЬКО добавляя проверки/ветки/функции; плюс новые файлы: engine/validate_ws.mjs, engine/warnings_ext.mjs, tests/hardening.test.mjs, tests/proto_keys.test.mjs, tests/validate_ws.test.mjs, tests/defaults_sync.test.mjs, tests/fixtures/journal-v1.json. Источники дефектов: ' + W + '\\product\\16-prototype-findings.md (P0/P1, кандидаты К-n), tests/adversarial/* (test.todo), ' + OPS + '\\gap\\quality-backlog.json и quality-audit.md.',
        'Сделай: (1) одиночная нога перевода НЕ пропадает молча (расход остаётся в events.plan; пара operating+operating по-прежнему исключается; golden G-001 без изменений) — снять todo semantics:1336; (2) слепые зоны верификатора (знаки минус U+2010/2012/2212/FE63/FF0D и слова «минус»/«negative», символы Cf — bidi U+202E и нулевой пробел, ссылочная разметка Markdown и URL без схемы) — снять todo verifier_io:227/231/237 без новых ложных тревог на шаблонах RU/EN; (3) parse_amount_cell: «12,50» при thousands="," отвергается как bad_amount; «1.234,50» и «1,234.50» читаются как прежде; (4) id-колонки export_csv не начинаются с = + - @ TAB CR; (5) класс __proto__: calibration.lag_observations, timeline.rule_statuses, flow_calibration и любой out[key] — с Object.hasOwn/Map; сквозной property-тест «любой id в любой словарь»; (6) validate_ws.mjs: проверка чужой рабочей области/журнала (формат, размеры, диапазоны параметров К-4, уникальность Id) с кодами ошибок; (7) defaults_sync: значения по умолчанию в engine совпадают с vocab.json (REQ-019); (8) оставшиеся P1 из quality-backlog по возможности. Известно: в среде нет бинаря hledger — TST-44 остаётся skip.',
        'ВАЖНО: правила 1–3 из ГЛАВНЫХ ПРАВИЛ. Ты не трогаешь demo/*. Запускай свои тесты + tests/adversarial/* + весь набор по затронутым модулям; перед отчётом запусти ПОЛНЫЙ node --test в prototype и приведи честные числа (допустимо единичное падение TST-54 из-за нагрузки — перезапусти отдельно).',
      ].join('\n'), 'high'),
  ])
}

if (PHASE === 'B') {
  results = await parallel([
    () => pack('FP-03', 'настройки, буфер, запас хода и честная готовность данных', PACK_NOTE, 'high'),
    () => pack('FP-04', 'быстрый ввод факта «+», сверка остатка одним числом и отмена', PACK_NOTE, 'high'),
    () => pack('FP-05', 'хранение (IndexedDB/память), файл-копия, экспорт и удаление данных', PACK_NOTE + ' Движок и demo уже умеют читать JSON рабочей области; хранилище — порт Store с реализациями in-memory и IndexedDB (в Node IndexedDB нет — контрактные тесты на in-memory и на фейк-IDB, написанный в тесте; navigator.locks доступен в Node 24).', 'high'),
    () => pack('FP-06', 'импорт: мастер CSV и hledger с сухим прогоном и откатом партии', PACK_NOTE + ' Зависимость FP-02 (иo-укрепление) уже выполнена — фаза A завершена.', 'high'),
    () => pack('FP-07', 'сценарии, правки волн и «почему» у каждого числа', PACK_NOTE, 'high'),
    () => pack('FP-09', 'витрины на готовом движке: долги, «в магазине», лестница сумм, эталон G-001, обещания, отчёт, клавиши', PACK_NOTE, 'high'),
  ])
}

if (PHASE === 'C') {
  const f08 = await pack('FP-08', 'формы данных: правила, часы, налог, накопления, курсы, счета, рассрочка',
    PACK_NOTE + ' Зависимости FP-01/02/03 выполнены; используй settings/запас хода FP-03 (см. demo/settings.mjs) и мост ws_edit/ws_bridge.', 'high')
  const integ = await ag([
    COMMON, '',
    '=== ТВОЯ РОЛЬ: ИНТЕГРАТОР ВОЛНЫ 1 (правишь общие файлы) ===',
    'Все feature packs FP-01…FP-09 реализованы разными агентами. Твои задачи: (1) прочитай все запросы ' + OPS + '\\impl\\hook-requests-FP*.md и ' + OPS + '\\impl\\*.md и примени нужные правки к demo/app.mjs, demo/i18n.mjs, demo/index.html, demo/style.css, tests/demo.test.mjs — ТОЛЬКО аддитивно; (2) выполни ПОЛНЫЙ прогон всех тестов, но БЕЗОПАСНО ДЛЯ ПАМЯТИ (на машине 7,8 ГБ RAM занято 93% другими приложениями; параллельный node --test уже дважды подвесил систему): НЕ запускай `node --test` без аргументов; запускай файлы ПО ОДНОМУ последовательно с таймаутом, например в Bash: cd prototype && for f in tests/*.test.mjs tests/adversarial/*.test.mjs; do echo "== $f"; timeout 200 node --test --test-timeout=180000 --test-concurrency=1 "$f" 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped|todo)|^✖ " ; done — и просуммируй числа вручную (всего/pass/fail/skip/todo); добейся 0 падений (todo/skip — только осмысленные), единичное падение TST-54 перезапусти отдельно; зависший файл (таймаут) — разобрать как баг; проверь, что ни один тест, существовавший до волны, не исчез: сравни с ' + OPS + '\\tst-coverage.json и количеством test() до/после (было 1099 вызовов test() и 1098 тестов); (3) запусти node ' + ROOT + '\\tools\\lint_vocab.mjs и node ' + ROOT + '\\tools\\lint.mjs — 0 ошибок в prototype-связанных страницах; (4) проверь статически, что каждый pack_fpNN.mjs загружается (все импорты разрешаются, TST-59), что нет конфликтов маршрутов/ключей i18n/идентификаторов DOM между пакетами; (5) пройди по критериям приёмки FP-01…FP-09 из backlog.json и составь ' + OPS + '\\impl\\wave1-acceptance.md: таблица | FP | критерий | статус (met/partial/unmet) | доказательство | и список того, что НЕ выполнено; (6) обнови ' + P + '\\README.md (карта модулей, новые файлы, числа тестов — фактические из запуска).',
    'Результаты пакетов (для справки): ' + JSON.stringify({ FP08: f08 && { files: f08.files, tests: f08.tests_pass + '/' + f08.tests_total, notes: f08.notes } }),
  ].join('\n'), { label: 'integrator', phase: PHASE, schema: SCHEMA, effort: 'high' })
  results = [f08, integ]
}

log('Фаза ' + PHASE + ': ' + results.filter(Boolean).length + '/' + results.length + ' агентов вернули результат')
return { phase: PHASE, results }
