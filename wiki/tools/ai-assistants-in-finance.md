---
title: "AI-ассистенты в финансах и MCP-серверы бюджета"
type: tool
status: verified
summary: "Встроенные AI (Monarch, Copilot, Rocket Money) и MCP-серверы для YNAB/Actual/Firefly/hledger/Lunch Money: что умеют, чем рискуют и какие паттерны проверки чисел взять в Runway."
sources: [https://getfinny.app/blog/monarch-money-pricing-2026, https://getfinny.app/blog/monarch-money-review-2026, https://sacra.com/c/monarch-money/, https://www.monarch.com/pricing, https://www.monarch.com/blog/monarch-plus, https://www.copilot.money/, https://toolradar.com/guides/best-ai-budgeting-apps, https://www.rocketmoney.com/, https://emma-app.com/, https://www.ynab.com/pricing, https://api.ynab.com/, https://github.com/calebl/ynab-mcp-server, https://github.com/s-stefanov/actual-mcp, https://github.com/etnperlong/firefly-iii-mcp, https://github.com/iiAtlas/hledger-mcp, https://github.com/akutishevsky/lunchmoney-mcp, https://modelcontextprotocol.io/specification/2026-07-28/server/tools, https://modelcontextprotocol.io/specification/2025-06-18/server/tools, https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices, https://genai.owasp.org/llmrisk/llm01-prompt-injection/, https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/, https://arxiv.org/abs/2503.18813, https://arxiv.org/abs/2211.12588, https://arxiv.org/abs/2311.11944, https://platform.claude.com/docs/en/build-with-claude/structured-outputs, https://platform.claude.com/docs/en/build-with-claude/citations, https://artificialintelligenceact.eu/annex/3/, https://artificialintelligenceact.eu/article/50/, https://artificialintelligenceact.eu/implementation-timeline/, https://github.com/modelcontextprotocol/servers, https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/]
updated: 2026-10-05
---

# AI-ассистенты в финансах и MCP-серверы бюджета

## Кратко

Две семьи: (1) чат-ассистенты внутри закрытых облачных SaaS; (2) MCP-серверы сообщества, подключающие LLM-клиент к API или файлу бюджета. Для тех, кто спрашивает данные словами. Цены и статус на 2026-10-04:

| Продукт | Модель | Цена / статус | Источник |
|---|---|---|---|
| Monarch AI assistant | SaaS, закрытый, нужна банковская синхронизация; iOS, Android, web | Core $14.99/мес или $99.99/год (ассистент в Core); Plus $199/год, только годовой (запуск 2026-04-20); триал 7 дней | [getfinny](https://getfinny.app/blog/monarch-money-pricing-2026), [Monarch Plus](https://www.monarch.com/blog/monarch-plus) |
| Copilot Money | SaaS, iPhone/iPad/Mac, web | $95/год; $13/мес | [copilot.money](https://www.copilot.money/), [toolradar](https://toolradar.com/guides/best-ai-budgeting-apps) |
| Rocket Money | SaaS, Rocket Companies | Free + Premium; сумма не указана, AI-чат не подтверждён | [rocketmoney.com](https://www.rocketmoney.com/) |
| Cleo, Emma | SaaS | Cleo: сайт отдал 403, не подтверждено. Emma: UK, FCA, четыре тарифа; AI-функций на странице нет | [emma-app.com](https://emma-app.com/) |
| MCP-серверы | open-source, MIT | YNAB (148★, push 2026-10-02), Actual (246★, 2026-10-02), Lunch Money (109★, неофициальный, 2026-08-03), hledger (65★, 2026-02-28), Firefly III (86★, push 2025-06-12 — давно не обновлялся) | [Actual MCP](https://github.com/s-stefanov/actual-mcp), [YNAB MCP](https://github.com/calebl/ynab-mcp-server) |

Оговорки к таблице:

- **Monarch:** суммы Core — вторичные источники, на офиц. странице не видны. Plus — первоисточник; включает Forecasting, business tracking, инвест-аналитику.
- **Copilot:** $95/год — офиц. сайт; $13/мес — только вторичные источники (mezzi, getfinny; не подтверждено первоисточником). Web — с 2025-12 (вторичный источник), Android нет. Авто-категоризация, детект подписок; чата-ассистента на странице нет.
- **MCP:** у YNAB и Lunch Money официального MCP не найдено, только community (Lunch Money MCP построен на alpha API v2).

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли к дате? | Частично | Ассистенты объясняют прошлое и сдвиги cash flow. Monarch Plus Forecasting (первоисточник) проецирует net worth и cash flow по реальным данным и событиям жизни; прогноза «минимальный баланс к дате X» в описании нет (не подтверждено). Cash-flow отчёты MCP-серверов — по факту |
| Q2 Волна платежей | Частично | Видны повторы: подписки (Copilot), recurring (Lunch Money MCP), bills (Firefly III), scheduled transactions (YNAB MCP). «Сколько нужно к волне» не описано |
| Q3 Могу ли купить? | Частично | Monarch Plus Forecasting позволяет добавлять на таймлайн события (в т.ч. крупные покупки) и видеть обновлённую проекцию (первоисточник); это инструмент UI, не вопрос ассистенту, вердикта «можно/нельзя» нет. LLM мог бы вызывать такой расчёт; готового нет (вывод) |
| Редкие траты | Частично | YNAB MCP двигает деньги между категориями и распределяет в недофинансированные; амортизации как расчёта нет |
| Налоги | Не найдено | Налоговых правил в ассистентах нет; расчёт всегда по введённым пользователем правилам, не консультация |

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | partial | Monarch Plus Forecasting (первоисточник): проекция net worth и cash flow; у MCP-серверов только отчёты по факту |
| can_i_afford | partial | Только Monarch Plus: события-покупки на таймлайне прогноза; у остальных не описано |
| recurring_and_waves | partial | Повторы видны; волн нет |
| sinking_funds | partial | Перекладка между конвертами (YNAB MCP), без амортизации |
| tax_envelope | unknown | Не найдено |
| multi_currency | unknown | Только крипто-позиции в Lunch Money MCP; валюты операций не проверены |
| hourly_income | unknown | Не найдено |
| privacy_local_first | partial | Локальный stdio + self-host (Actual, Firefly, hledger); у Monarch ручной режим не подтверждено первоисточником (2026-10-04) |
| import_export | partial | CRUD транзакций и hledger import через MCP; у YNAB API лимит 200 запросов/час |
| ai_assistant | partial | MCP = вызов инструментов, но проверки чисел нигде не документированы |
| openness | partial | MCP-серверы MIT; Monarch/Copilot/Rocket закрыты |

## Как это устроено

1. **Облачный ассистент (Monarch):** банки → хранилище транзакций → NL-вопрос → ответ, с показом исходных транзакций (по обзору [getfinny](https://getfinny.app/blog/monarch-money-review-2026)); вне подписки недоступен.
2. **MCP:** клиент ↔ сервер (stdio локально или HTTP/Cloudflare Workers) ↔ API или файл. Модель сама выбирает инструмент по JSON Schema; по спецификации (актуальная версия 2026-07-28, в 2025-06-18 то же) человек SHOULD иметь возможность отклонить вызов ([spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
3. **Единицы денег:** YNAB — milliunits, сервер конвертирует; Actual — целые центы; hledger — CLI над журналом.
4. **Режимы доступа:** `YNAB_READ_ONLY`; в Actual запись только с `--enable-write`, публичный URL — с bearer-токеном; hledger `--read-only`, `.bak`-копии, dry-run, `hledger check`.
5. **Секреты:** YNAB-сервер держит токен в переменной окружения, модель его не видит.
6. **Поток:** вопрос → tool call → JSON в контекст → модель пишет текст. Числа в тексте пишет модель; сверки не документированы.

## Сильные стороны

- Естественный язык поверх существующих данных без нового интерфейса.
- MCP-серверы бесплатны (MIT); часть имеет read-only и dry-run.
- MCP допускает `outputSchema`: сервер MUST выдавать соответствующий результат, клиент SHOULD его проверять (то есть не обязан).

## Слабые стороны и ограничения

| Риск | Что известно | Источник |
|---|---|---|
| Галлюцинации чисел | Бенчмарк FinanceBench: GPT-4-Turbo с retrieval неверно ответил или отказался в 81% вопросов (выборка 150 по фин. документам, 2023; для бюджетов (вывод) риск тот же по природе) | [arXiv](https://arxiv.org/abs/2311.11944) |
| Prompt injection через описания транзакций | Косвенная инъекция — внешний контент меняет поведение модели; (вывод) поле «описание» из банковского импорта — недоверенный ввод | [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) |
| «Смертельная тройка» | Приватные данные + недоверенный контент + исходящий канал; решение — не совмещать все три | [Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) |
| Утечка данных и код сервера | Результаты tool-вызовов уходят провайдеру LLM, если модель не локальная (вывод); локальный MCP-сервер исполняется с правами клиента; даже референсные серверы MCP-репозитория названы учебными, не production | [security](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices), [servers](https://github.com/modelcontextprotocol/servers) |
| Регуляторика (кратко, не юр. вывод) | AI Act — список ниже. Граница «совет vs информация» источником не подтверждена | [Art. 50](https://artificialintelligenceact.eu/article/50/), [Annex III](https://artificialintelligenceact.eu/annex/3/) |

Регуляторика (AI Act, кратко, не юр. вывод):

- Art. 50(1): информировать, что общение идёт с ИИ, если это не очевидно из контекста (с 2026-08-02).
- Art. 50(2): для маркировки контента у уже выведенных систем отсрочка до 2026-12-02.
- Annex III 5(b): оценка кредитоспособности физлиц — high-risk, кроме выявления мошенничества; срок перенесён Digital Omnibus на 2027-12-02 ([Gibson Dunn](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/)).

Валидная схема JSON не гарантирует верность чисел: structured outputs обеспечивают форму, но не при отказе или обрыве по токенам ([docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).

## Данные и приватность

| Продукт | Где данные | API / экспорт | Self-host |
|---|---|---|---|
| Monarch | Облако; ручной режим не подтверждено первоисточником (2026-10-04) | API/экспорт не проверены (не подтверждено) | Нет |
| Copilot | Облако; заявление о приватности не проверено | Не проверено (не подтверждено) | Нет |
| YNAB | Облако | Токен или OAuth, 200 запросов/час, community MCP указан в docs | Нет |
| Actual | Локальные данные или sync-сервер, опционально E2E-пароль | Node-пакет, не REST | Да |
| Firefly III / hledger | Свой сервер / локальные файлы | PAT; CLI | Да |

## Что взять в Runway

| Идея | Как реализовать |
|---|---|
| Число пишет только движок | LLM возвращает структурированные утверждения-шаблоны со ссылками на вызовы; рендерер подставляет значения из результата движка |
| Verifier | Постпроверка: каждое число в тексте ∈ значениям tool-результатов; иначе повтор или «не удалось подтвердить» |
| Citations на вызовы движка | Чип «из расчёта #call_id» раскрывает параметры, сценарий, версию движка и дату узкой точки; идея параллельна [Citations API](https://platform.claude.com/docs/en/build-with-claude/citations) для документов |
| Read-only по умолчанию | Запись — только как черновик с подтверждением; dry-run и откат (как `.bak`/dry-run в hledger-mcp) |
| Описания транзакций — данные | Изолировать в блок данных, не исполнять; у ассистента нет сети и рендера внешних ссылок/картинок; план вызовов фиксируется до чтения недоверенного (идея [CaMeL](https://arxiv.org/abs/2503.18813)) |
| Счёт вне модели | Рассуждение — программой, вычисление — интерпретатору ([PoT](https://arxiv.org/abs/2211.12588)) |
| Локальный режим | Локальный stdio-сервер, токены вне контекста, опция локальной модели |
| Раскрытие ИИ | Пометка «ответ ИИ, числа из расчёта #N» |

```pseudo
answer(question):
  plan  = LLM.tool_calls(question)          # имена и параметры, без чисел
  facts = [engine.run(c) for c in plan]     # детерминированно, c.call_id, inputs_hash
  draft = LLM.structured(claims=[{template, refs}])   # «…{c1.min_balance}…»
  text  = render(draft, facts)              # числа подставляет рендерер
  if not (numbers(text) ⊆ values(facts) and refs_exist): retry_once_or_refuse()
```

## Чего избегать

- Чисел, сгенерированных моделью, и обещаний «без галлюцинаций» без публичной проверки (у [Budget Guru](../tools/budget-guru.md) это лишь заявление лендинга).
- Tools записи без read-only режима; публичного MCP-endpoint без токена; секретов в контексте модели.
- Доверия аннотациям tool от неизвестных серверов: спецификация считает их недоверенными.
- Ассистента как единственного пути к числу: рядом всегда таблица.
- Советов «что купить»: показывать результат расчёта по введённым правилам.

## Источники

- https://www.monarch.com/blog/monarch-plus — первоисточник: Plus $199/год, Forecasting, запуск 2026-04-20 — 2026-10-04
- https://getfinny.app/blog/monarch-money-pricing-2026 — цены Core/Plus, ассистент в Core (статья 2026-06-09) — 2026-10-04
- https://getfinny.app/blog/monarch-money-review-2026 — ассистент отвечает на вопросы по транзакциям; банки обязательны; прогноза в обзоре нет (2026-05-03); платформы iOS/Android/web — 2026-10-04
- https://sacra.com/c/monarch-money/ — описание ассистента, Series B 2025-05 — 2026-10-04
- https://www.monarch.com/pricing — на странице видны лишь Core/Plus и триал — 2026-10-04
- https://www.copilot.money/ — $95/год, авто-категоризация, платформы — 2026-10-04
- https://toolradar.com/guides/best-ai-budgeting-apps — сравнение цен (сентябрь 2026), YNAB без ассистента — 2026-10-04
- https://www.rocketmoney.com/, https://emma-app.com/ — тарифы без сумм, владелец; Emma: FCA, open banking — 2026-10-04
- https://www.ynab.com/pricing, https://api.ynab.com/ — цена, лимит 200/час, community MCP — 2026-10-04
- https://github.com/calebl/ynab-mcp-server, https://github.com/s-stefanov/actual-mcp, https://github.com/etnperlong/firefly-iii-mcp, https://github.com/iiAtlas/hledger-mcp, https://github.com/akutishevsky/lunchmoney-mcp — инструменты, режимы, MIT, даты push (api.github.com) — 2026-10-04
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools (актуальная), /2025-06-18/server/tools и /basic/security_best_practices — human in the loop, outputSchema, недоверенные аннотации — 2026-10-04
- https://genai.owasp.org/llmrisk/llm01-prompt-injection/, https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/, https://arxiv.org/abs/2503.18813 — инъекции, тройка, CaMeL (77% против 84% на AgentDojo) — 2026-10-04
- https://arxiv.org/abs/2311.11944, https://arxiv.org/abs/2211.12588 — FinanceBench, PoT — 2026-10-04
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs, https://platform.claude.com/docs/en/build-with-claude/citations — гарантии схемы и их исключения; citations — 2026-10-04
- https://artificialintelligenceact.eu/article/50/, /annex/3/, /implementation-timeline/, Gibson Dunn (Digital Omnibus, Совет 2026-06-29) — прозрачность, high-risk, даты — 2026-10-04

Проверка: скептическая перепроверка 2026-10-04 (28 утверждений проверено); подтверждено 20, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Grounded AI-ассистент](../concepts/grounded-ai-assistant.md)
- [Local-first и приватность](../concepts/local-first-privacy.md)
- [Могу ли я это купить](../concepts/can-i-afford-it.md)
- [YNAB](../tools/ynab.md), [Actual Budget](../tools/actual-budget.md), [Budget Guru](../tools/budget-guru.md)
- [Разбор Budget Guru](../comparisons/budget-guru-teardown.md)
