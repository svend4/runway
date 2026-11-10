# Запрос хука FP-20 — применён пакетом (волна 3а-2)

Пакет FP-20 (ассистент A0: чип происхождения и «почему» у каждого ответа, «что изменилось с <даты>», журнал вызовов `assistant.call` только с хэшами) внёс минимальные правки в общие файлы сам, без интегратора. Что именно и где проверяется:

| Файл | Правка | Проверка |
|---|---|---|
| `prototype/demo/ext.mjs` | в `HOOKS` добавлен `assistant` (действия `chip` и `ports`); описание в комментарии | `tests/ext.test.mjs` (список хуков) |
| `prototype/demo/ext_manifest.mjs` | пакет `pack_fp20` в `PACKS` и `LOADERS` | `tests/demo.test.mjs`, `tests/ext.test.mjs` (списки пакетов) |
| `prototype/demo/app.mjs` | помощник `a0_hook` (единственная новая строка со словом `ext`: 25 из 25 по пределу `waves_card`); `calc_chip` спрашивает хук и оставляет прежнюю кнопку запасной; `parse_assistant_command` после прежних правил опрашивает `parse_ext_intent`; `ask_a0` принимает необязательные порты (`journal`, `call_log`, `last_call`, `record`); обработчик вопроса передаёт порты хука и знает три новых причины отказа | `tests/assistant_ext.test.mjs`, `tests/waves_card.test.mjs`, `tests/fp17_fix2.test.mjs`, `tests/number_format_surfaces.test.mjs` |
| `prototype/demo/i18n.mjs` | `as.no_since`, `as.shift_days`, `as.shift_unsupported`; `as.unrecognized` называет новые вопросы | `tests/demo.test.mjs` (TST-56) |
| `prototype/engine/verifier.mjs` | отдельные таблицы `EXT_INTENTS`, `EXT_COMMANDS`, функция `parse_ext_intent`; в `parse_command` ветка `default` сначала смотрит `EXT_COMMANDS`; прежние слова и отказы не изменены | `tests/verifier.test.mjs` (33), `tests/assistant_ext.test.mjs` |

`engine/tools.mjs`, `index.html`, `style.css`, `serve.mjs`, `vocab.json`, golden и `arith.lock` не менялись. Подробности и ограничения — `prototype/README.md`, раздел «Волна 3а-2 · FP-20», и `prototype/demo/README_ext.md`, раздел «Пакет FP-20».

## Исправления после независимой проверки (тот же пакет, правки общих файлов)

| Файл | Правка | Проверка |
|---|---|---|
| `prototype/demo/app.mjs` | импорт `changes_view` из `engine/call_log.mjs`; `ask_a0` строит для `what_changed` представление журнала (отказ `no_history`, «с начала дня», «с прошлого раза» по порядку записей), передаёт `notes` допущений в `a0_answer` и возвращает `info`; помощник `a0_note_node` (третье обращение к `a0_hook`, действие `note`); отображение причины `no_history` с датой. Строк со словом `ext` не добавлено (25 из 25) | `tests/assistant_ext.test.mjs`, `tests/fp20_adv.test.mjs`, `tests/waves_card.test.mjs`, `tests/fp17_fix2.test.mjs` |
| `prototype/demo/i18n.mjs` | `as.no_history` (RU и EN); пример в `as.no_since` | `tests/demo.test.mjs` (TST-56) |
| `prototype/engine/verifier.mjs` | `RE_CHANGED` (граница у кириллицы), `names_own_payment` (платёж с уточнением), `notes` у разбора сдвига, `assumed.year_rolled` у «что изменилось», шаблоны `SHIFT.NOTE*`, `EXT_NOTES`, `opts.notes` у `a0_answer` (эхо `q.shift_days`) | `tests/verifier.test.mjs` (33), `tests/injection.test.mjs`, `tests/assistant_ext.test.mjs` |

`engine/tools.mjs` (в том числе `what_changed` и `state_at`), `index.html`, `style.css`, `serve.mjs`, `vocab.json`, golden и `arith.lock` не менялись.
