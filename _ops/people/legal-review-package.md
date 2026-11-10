# Пакет для юридического ревью формулировок (REQ-183)

> Файл собран скриптом `prototype/tools/people_pack.mjs` из кода приложения; **руками не править** (таблицы пересоберутся). Это не юридическая консультация и не заменяет её:
> пакет только собирает тексты про налоги, «советы» и точность, чтобы их прочитал специалист. Расчёт по введённым данным и правилам, не консультация.

| Что | Значение |
|---|---|
| Отпечаток выгрузки (sha256, 16 знаков) | `c32a7633796a0443` |
| Версия движка | `0.1.0` |
| Каталогов строк · строк всего | 34 · 3339 |
| Строк в выборке (§3) | 317 (налоги — 173, советы — 122, точность — 56; строка может относиться к нескольким классам) |
| Из них про налоги без оговорки в самой строке | 157 (оговорка может стоять рядом на экране: проверяется по интерфейсу, а не по строке) |
| Утверждений в реестре обещаний (§4) | 24 |
| Дата выгрузки, ревьюер, решение | записываются в отдельной записи ревью по шаблону §6, не здесь |

## 1. Зачем этот пакет и что нужно от ревьюера

Runway — приложение для прогноза денежного потока: оно считает по данным и правилам, которые ввёл сам человек, и показывает минимум свободных денег, ответ на вопрос «могу ли я купить» и запас под налоги. В интерфейсе три группы текстов, которые требуют взгляда юриста (RISK-06, RISK-11, [REQ-183](../../wiki/product/02-requirements.md)):

1. **Налоги.** Ставок и шаблонов стран в приложении нет; налоговые правила — данные пользователя, а приложение откладывает «в конверт» долю, которую задал он сам. Нужна оценка, не станет ли такой показ налоговой консультацией, и достаточны ли оговорки.
2. **«Советы».** Вердикт («выдерживает / впритык / хрупко / не хватает») и «можно потратить» — это расчёт ликвидности по правилам пользователя, а не рекомендация покупать или не покупать. Нужна оценка, как это прочтёт человек, и не пересекает ли формулировка границу «информация против совета».
3. **Точность.** Приложение не обещает точность прогноза; есть реестр утверждений с уровнем доказанности («проверено тестом», «измерено», «гипотеза» в интерфейс не попадает). Нужна оценка, не создаёт ли какая-то формулировка обещания, которого продукт не даёт.

**О чём просим.** Прочитать таблицы §3–§5. По каждой строке отметить «принять», «заменить текстом …» или «удалить». Ответить на вопросы Q1–Q8 ниже. Решить судьбу налоговой части: оставить, оставить с изменениями или удалить (если ревью признаёт налоговую часть консультацией, она удаляется: правила REQ-064…068, ALG-06; остаются накопление на страховку и ручной резерв, строка № 5 раздела «Критерии остановки и пивота» дорожной карты). Назвать юрисдикции, для которых вывод верен.

**О чём не просим.** Не просим проверять арифметику прогноза и не просим консультации по налогам для конкретного человека.

**Вопросы ревьюеру.**

| № | Вопрос |
|---|---|
| Q1 | Считается ли показ суммы «в конверт по правилу пользователя» налоговой консультацией, если ставку вводит сам пользователь, а приложение ставок не содержит? |
| Q2 | Достаточна ли оговорка «расчёт по введённым данным и правилам, не консультация» (§5.1) и на каких поверхностях она обязательна (обзор, покупка, резервы, ответы ассистента, печать)? |
| Q3 | Читается ли вердикт («выдерживает / впритык / хрупко / не хватает») и «можно потратить» как рекомендация? Допустимы ли заголовки вида «Могу ли я это купить?»? |
| Q4 | Достаточно ли «не обещаем точность прогноза» и отметки «эксперимент, не обещание» у вероятностных оценок? Нужна ли оговорка о том, что прошлые платежи не предсказывают будущие? |
| Q5 | Нет ли совета в шаблонах ответов ассистента A0 (строки из `engine/verifier.mjs`)? |
| Q6 | Какими словами можно сказать после ревью, что оно проведено (сейчас в интерфейсе: «Юридическое ревью формулировок … не выполнены»)? |
| Q7 | Нужны ли для версии без аккаунтов и без сервера отдельные условия использования и сведения об ответственности (в приложении их нет)? |
| Q8 | Есть ли формулировки, которые для вашей юрисдикции нельзя употреблять даже с оговоркой? |

## 2. Как устроен пакет

- Источник — код, а не копия вручную: каталоги строк `prototype/demo/i18n.mjs` и `prototype/demo/i18n/*.mjs`, шаблоны ответов `prototype/engine/verifier.mjs`, шаблон-скелет мастера «Старт» `prototype/demo/start_template.mjs`, реестр обещаний `prototype/demo/promises.json`, словарь `prototype/engine/vocab.json`.
- Выборка по ключевым словам с запасом (RU или EN): налоги — «налог», «конверт», tax, envelope, VAT, НДС, IVA, «вычет», declaration; советы — «совет», «консульт», «рекоменд», advice, recommend, «инвестиц», «юрид», «вердикт», «можно потратить», «могу ли я купить»; точность — «точност», accuracy, «гарант», «обещ», promise, «уверенност», «вероятност», «эксперимент». Строка с любым словом попадает в таблицу целиком. Налоговый конверт и правила не всегда называют налог словом, поэтому к налогам отнесены ещё строки по ключу: куски ключа, начинающиеся с `tax` или `envelope` (например `rs.tax_line`, `forms.tax_none`, `forms.h_tax_rate`, `forms.f_rate_tax`), и все ключи экранов `rs.*` («Резервы») и `reserveui.*` (карточки резервов и разбор «Как посчитано»). Если на экране есть строка про налоги, советы или точность, которой нет в таблице, это дефект выборки: сообщить, пакет будет пересобран.
- Номер строки `№` — для ссылок в записи ревью. Номера меняются при пересборке: в записи ревью указывать и номер, и ключ, и отпечаток выгрузки.
- Пересборка: `node tools/people_pack.mjs legal` из `prototype/`; проверка, что пакет не устарел: `node tools/people_pack.mjs legal --check` (код выхода 1, если файл расходится с кодом). Тест `tests/people_pack.test.mjs` делает ту же проверку.
- В пакет не входят тексты вне перечисленных источников (вики, README, страницы вне приложения): их читают по ссылкам из записи ревью.

## 3. Строки интерфейса: налоги, «советы», точность

Колонка «Оговорка» — есть ли в самой строке «не консультация» или «not advice». «Классы»: н — налоги, с — советы, т — точность.

| № | Файл · ключ | Классы | RU | EN | Оговорка |
|---:|---|:-:|---|---|:-:|
| 1 | `i18n.mjs` · `app.footer` | с | Движок {version} · inputs {hash} · расчёт по введённым данным и правилам, не консультация. Все числа посчитаны на этой странице; ваши данные никуда не отправляются, файлы страница читает только с собственного хоста. | Engine {version} · inputs {hash} · calculated from the data and rules you entered; not advice. All numbers are calculated in this page; your data is not sent anywhere, and the page reads files only from its own host. | да |
| 2 | `i18n.mjs` · `c.tax_note` | н с | Расчёт по введённым правилам, не консультация. | Calculated from the rules you entered; not advice. | да |
| 3 | `i18n.mjs` · `as.q_tax` | н | налог | tax | нет |
| 4 | `i18n.mjs` · `as.t_sts` | с | можно потратить | spendable amount | нет |
| 5 | `i18n.mjs` · `as.t_tax` | н | налоговый конверт | tax envelope | нет |
| 6 | `i18n.mjs` · `banner.block` | с | Данных мало для вердикта. Сверьте остаток. | Not enough data for a verdict. Reconcile the balance. | нет |
| 7 | `i18n.mjs` · `warn.W_NO_RESERVES` | н с | Налоговый конверт и накопления не заданы: вердикт и «можно потратить» посчитаны по физическим деньгам. | No tax envelope or savings are set: the verdict and the spendable amount use physical cash. | нет |
| 8 | `i18n.mjs` · `gate.readiness` | с | Данных мало для вердикта: готовность данных ниже порога, проверьте, что не учтено. | Not enough data for a verdict: data readiness is below the threshold, check what is not included. | нет |
| 9 | `i18n.mjs` · `gate.stale` | с | Остаток не сверялся давно: сверьте остаток, вердикт заменён этой подсказкой. | The balance has not been reconciled for a long time: reconcile it; the verdict is replaced by this note. | нет |
| 10 | `i18n.mjs` · `gate.generic` | с | Данных мало для вердикта. | Not enough data for a verdict. | нет |
| 11 | `i18n.mjs` · `ov.sts_title` | с | Можно потратить | Spendable | нет |
| 12 | `i18n.mjs` · `ov.sts_gate` | с | Число «можно потратить» не показано: {reason} | The spendable amount is not shown: {reason} | нет |
| 13 | `i18n.mjs` · `ov.go_buy` | с | Могу ли я купить? | Can I buy it? | нет |
| 14 | `i18n.mjs` · `bd.title` | с | Как посчитано «можно потратить» | How the spendable amount is calculated | нет |
| 15 | `i18n.mjs` · `buy.title` | с | Могу ли я это купить? | Can I buy it? | нет |
| 16 | `i18n.mjs` · `buy.lead` | с | Три ответа за один жест: вердикт, максимум на дату и самая ранняя дата. | Three answers in one gesture: a verdict, the maximum for a date and the earliest date. | нет |
| 17 | `i18n.mjs` · `buy.verdict` | с | Вердикт | Verdict | нет |
| 18 | `i18n.mjs` · `buy.cash_but_reserved` | н | Деньги есть (минимум {value}), но свободных нет — они закреплены под налог и накопление. | There is money (lowest {value}), but none of it is free — it is set aside for tax and savings. | нет |
| 19 | `i18n.mjs` · `buy.liquidity` | с т | Это расчёт ликвидности по вашим правилам и данным, не рекомендация. | This is a liquidity calculation based on your rules and data, not a recommendation. | да |
| 20 | `i18n.mjs` · `buy.gate_title` | с | Вердикт отключён | Verdict switched off | нет |
| 21 | `i18n.mjs` · `rs.title` | н | Резервы | Reserves | нет |
| 22 | `i18n.mjs` · `rs.lead` | н | Что закреплено под налог и накопления и сколько свободно. | What is set aside for tax and savings, and how much is free. | нет |
| 23 | `i18n.mjs` · `rs.free` | н | Свободный остаток | Free balance | нет |
| 24 | `i18n.mjs` · `rs.free_line` | н | Остаток {balance} − резервы {reserved} = свободно на сегодня {free}. | Balance {balance} − reserves {reserved} = free today {free}. | нет |
| 25 | `i18n.mjs` · `rs.free_masked` | н | Остаток {balance}. Резервы и «свободно на сегодня» не показаны: правило не подтверждено с {since}; числа скрыты до его подтверждения или правки. | Balance {balance}. Reserves and "free today" are not shown: the rule has not been confirmed since {since}; the numbers stay hidden until it is confirmed or changed. | нет |
| 26 | `i18n.mjs` · `rs.min_free` | н | Минимум свободных денег: {plan} · {d_plan} (по плану), {worse} · {d_worse} (если хуже). | Lowest free money: {plan} · {d_plan} (as planned), {worse} · {d_worse} (if worse). | нет |
| 27 | `i18n.mjs` · `rs.sts` | н с | Можно потратить (STS) | Spendable (STS) | нет |
| 28 | `i18n.mjs` · `rs.tax` | н | Налоговый конверт | Tax envelope | нет |
| 29 | `i18n.mjs` · `rs.tax_rule` | н | правило «{name}»: {rate} | rule “{name}”: {rate} | нет |
| 30 | `i18n.mjs` · `rs.tax_line` | н | С выплаты {income} по вашему правилу {rate} отложено {value}. | {value} is set aside from the {income} payout under your {rate} rule. | нет |
| 31 | `i18n.mjs` · `rs.tax_in` | н | в конверте {now} · на конец горизонта {end} | in the envelope {now} · at the end of the horizon {end} | нет |
| 32 | `i18n.mjs` · `rs.tax_masked` | н | Числа конверта скрыты: правило не подтверждено с {since}; они вернутся после подтверждения или правки правила. | The envelope numbers are hidden: the rule has not been confirmed since {since}; they return once the rule is confirmed or changed. | нет |
| 33 | `i18n.mjs` · `rs.tax_next` | н | ближайший налоговый платёж: {value}, {date} | next tax payment: {value}, {date} | нет |
| 34 | `i18n.mjs` · `rs.tax_release` | н | Следующее списание из конверта: {date} — платёж {payment}, из конверта {released}, сверх конверта {true_up}. | Next withdrawal from the envelope: {date} — payment {payment}, {released} from the envelope, {true_up} beyond it. | нет |
| 35 | `i18n.mjs` · `rs.tax_release_full` | н | Следующее списание из конверта: {date} — платёж {payment} целиком из конверта. | Next withdrawal from the envelope: {date} — the payment of {payment} comes entirely from the envelope. | нет |
| 36 | `i18n.mjs` · `rs.rule_state` | н | состояние правила: {state} | rule state: {state} | нет |
| 37 | `i18n.mjs` · `rs.state_fresh` | н | свежее | fresh | нет |
| 38 | `i18n.mjs` · `rs.state_stale` | н | устарело | stale | нет |
| 39 | `i18n.mjs` · `rs.state_disabled` | н | не подтверждено | not confirmed | нет |
| 40 | `i18n.mjs` · `rs.tax_none` | н | Правило не задано: конверт не считается. Введите правило, чтобы видеть откладываемую сумму. | No rule is set: the envelope is not calculated. Enter a rule to see the amount to set aside. | нет |
| 41 | `i18n.mjs` · `rs.sinking` | н | Накопления (sinking) | Savings (sinking) | нет |
| 42 | `i18n.mjs` · `rs.sinking_line` | н | {name}: цель {target} к {due}; сейчас в резерве {now}; на конец горизонта {end}. | {name}: target {target} by {due}; in the reserve now {now}; at the end of the horizon {end}. | нет |
| 43 | `i18n.mjs` · `rs.sinking_masked` | н | {name}: цель {target} к {due}. Суммы резерва скрыты: правило, которое его пополняет, не подтверждено с {since}; они вернутся после подтверждения или правки правила. | {name}: target {target} by {due}. The reserve amounts are hidden: the rule that feeds it has not been confirmed since {since}; they return once the rule is confirmed or changed. | нет |
| 44 | `i18n.mjs` · `rs.sinking_contrib` | н | взнос {value}, {date} | contribution {value}, {date} | нет |
| 45 | `i18n.mjs` · `rs.sinking_none` | н | Накоплений нет. | No savings are set. | нет |
| 46 | `i18n.mjs` · `rs.none` | н с | Налоговый конверт и накопления не заданы: вердикт и «можно потратить» посчитаны по физическим деньгам. | No tax envelope or savings are set: the verdict and the spendable amount use physical cash. | нет |
| 47 | `i18n.mjs` · `rs.total_end` | н | Резервы на конец горизонта: {value}. | Reserves at the end of the horizon: {value}. | нет |
| 48 | `i18n.mjs` · `sc.row_sts` | с | Можно потратить | Spendable | нет |
| 49 | `i18n.mjs` · `as.placeholder` | с | можно ли купить за 300 € 12 октября | can I buy for 300 € on October 12 | нет |
| 50 | `i18n.mjs` · `as.ex1` | с | можно ли купить за 300 € 12 октября | can I buy for €300 on October 12 | нет |
| 51 | `i18n.mjs` · `as.ex2` | с | сколько можно потратить 12 октября | how much can I spend on October 12 | нет |
| 52 | `i18n.mjs` · `as.ex3` | с | когда можно купить за 300 € | when can I buy for €300 | нет |
| 53 | `i18n.mjs` · `as.ex6` | н | налоговый конверт | tax envelope | нет |
| 54 | `i18n.mjs` · `as.unrecognized` | н с | Не удалось разобрать вопрос. Понимаются вопросы про покупку («можно ли купить за 300 € 12 октября»), максимум на дату, самую раннюю дату, волны, узкую точку, налоговый конверт, сдвиг поступления, резерв или то, что изменилось с даты («что изменилось с 1 октября»). | Could not parse the question. These questions are understood: a purchase (“can I buy for €300 on October 12”), the maximum for a date, the earliest date, waves, the narrowest point, the tax envelope, a shifted receipt, a reserve or what changed since a date (“what changed since October 1”). | нет |
| 55 | `i18n.mjs` · `as.disclaimer` | н с т | Ассистент отвечает на вопросы о вашем расчёте; это не рекомендация и не налоговая консультация. | The assistant answers questions about your calculation; it is not a recommendation or tax advice. | да |
| 56 | `i18n/a0ext.mjs` · `a0ext.calls_lead` | с | Каждый ответ ассистента на этом экране оставляет в журнале этой страницы запись только с хэшами и служебными метками: текста вопросов и значений аргументов в записи нет. Записи нет в режиме «только чтение», при ошибке инструмента, при отказе разобрать вопрос и у вердикта на экране «Купить»: его номер расчёта виден в чипе, но в этот журнал не попадает. | Every assistant answer on this screen leaves a record in this page’s journal with hashes and service labels only: the record has no question text and no argument values. There is no record in read-only mode, when a tool fails, when a question cannot be parsed, or for the verdict on the “Buy” screen: its calculation number is shown in the chip but does not enter this journal. | нет |
| 57 | `i18n/about.mjs` · `about.lead` | с | Runway считает прогноз денежного потока на этом устройстве. Расчёт по введённым данным и правилам, не консультация. | Runway calculates the cash-flow forecast on this device. A calculation from the data and rules you entered, not advice. | да |
| 58 | `i18n/about.mjs` · `about.legal_3` | с | Юридическое ревью формулировок и вычитка RU/EN людьми не выполнены. | Legal review of the wording and a human RU/EN proofread have not been done. | нет |
| 59 | `i18n/benchpg.mjs` · `benchpg.note_hyp` | т | Это один замер: цифры — гипотезы-бюджеты (ADR-014), а не обещания продукту. На другом устройстве или при другой нагрузке результат будет другим. | This is a single run: the figures are budget hypotheses (ADR-014), not promises to the product. On another device or under another load the result will differ. | нет |
| 60 | `i18n/calendars.mjs` · `calendars.h_plan_tag` | н | Если у вас есть правила резервов или налоговые правила по метке, платёж попадёт в них. | If you have reserve rules or tax rules by tag, the payment goes into them. | нет |
| 61 | `i18n/coldpg.mjs` · `coldpg.verdict_out` | т | Цель-гипотеза REQ-152 (не более {limit} мс): медиана выше цели на этом устройстве в этом замере — это задача оптимизации, а не обещание продукту. | REQ-152 target hypothesis (at most {limit} ms): the median is above the target on this device in this run — an optimisation task, not a promise to the product. | нет |
| 62 | `i18n/coldpg.mjs` · `coldpg.note_hyp` | т | Это один замер: цель в 2 секунды — гипотеза, не обещание продукту. | This is a single run: the 2-second target is a hypothesis, not a promise to the product. | нет |
| 63 | `i18n/data.mjs` · `data.loss_tax_rules` | н с | налоговые правила пользователя (расчёт по введённым правилам, не консультация) | the user's tax rules (calculated from the rules you entered; not advice) | да |
| 64 | `i18n/data.mjs` · `data.engine_newer` | т | Файл сделан более новой версией движка ({file}; сейчас {current}): эта версия могла прочитать часть записей неточно. | The file was made by a newer engine version ({file}; now {current}): this version may have read some records inexactly. | нет |
| 65 | `i18n/defaults.mjs` · `defaults.p_ready_q3` | с | Порог готовности для «можно потратить» | Readiness threshold for "spendable" | нет |
| 66 | `i18n/defaults.mjs` · `defaults.p_calib_alpha_bp` | т | Калибровка: уровень доверия | Calibration: confidence level | нет |
| 67 | `i18n/defaults.mjs` · `defaults.p_mc_n_paths` | т | Число путей в вероятностном расчёте | Paths in the probabilistic run | нет |
| 68 | `i18n/entry.mjs` · `entry.guard_text` | с | Перевод {amount} на счёт «{to}» уменьшает остаток операционных счетов, а резерв остаётся прежним: те же деньги вычитаются из «можно потратить» второй раз. | A transfer of {amount} to "{to}" lowers the balance of the operating accounts while the reserve stays the same: the same money is subtracted from the spendable amount a second time. | нет |
| 69 | `i18n/entry.mjs` · `entry.pend_text` | с | Перевод {amount} на «{to}» от {date}: резерв остался прежним, поэтому те же деньги вычтены из «можно потратить» дважды. | Transfer of {amount} to "{to}" on {date}: the reserve stayed the same, so the same money is subtracted from the spendable amount twice. | нет |
| 70 | `i18n/entry.mjs` · `entry.u_tax_rule` | н | изменение налогового правила | tax rule change | нет |
| 71 | `i18n/feedx.mjs` · `feedx.wf_foot` | с | Расчёт по введённым данным и правилам, не консультация · расчёт {hash} | Calculated from the data and rules you entered; not advice · calculation {hash} | да |
| 72 | `i18n/feedx.mjs` · `feedx.wp_foot` | с | Расчёт по введённым данным и правилам, не консультация. | Calculated from the data and rules you entered; not advice. | да |
| 73 | `i18n/feedx.mjs` · `feedx.wm_until` | с | Дата расчёта — {date} (из поля «Можно потратить · до даты»; карточка пересчитывается при открытии экрана). | Calculation date: {date} (from the “Spendable · until” field; the card is recalculated when the screen is opened). | нет |
| 74 | `i18n/feedx.mjs` · `feedx.wm_payments` | н | Платежи до {at} за вычетом поступлений | Payments until {at}, net of income | нет |
| 75 | `i18n/feedx.mjs` · `feedx.sp_verdict` | с | Вердикт по проверенным платежам: {verdict}. Минимум свободных после покупки: {plan} — {m_plan} ({d_plan}); {worse} — {m_worse} ({d_worse}). | Verdict for the checked payments: {verdict}. The lowest free amount after the purchase: {plan} — {m_plan} ({d_plan}); {worse} — {m_worse} ({d_worse}). | нет |
| 76 | `i18n/feedx.mjs` · `feedx.sp_no_verdict` | с т | Вердикт по разбивке не построен: данных недостаточно или все платежи лежат за горизонтом. | No verdict for the split: there is not enough data, or every payment falls beyond the horizon. | нет |
| 77 | `i18n/feedx.mjs` · `feedx.sp_note` | т | График по модели не равен договору банка (дни, комиссии, плавающая ставка); «держится» — самая ранняя дата, а не обещание для всех более поздних. | The model schedule is not the bank’s contract (days, fees, a floating rate); “holds” is the earliest date, not a promise for every later one. | нет |
| 78 | `i18n/forms.mjs` · `forms.lead` | н | Здесь вводятся правила, часы, налоговое правило, накопления, курсы, счета и рассрочка. Каждая форма до записи показывает, что получится; отказ называет код ошибки и ничего не меняет. | Enter rules, hours, a tax rule, savings goals, exchange rates, accounts and instalments here. Each form shows the outcome before saving; a refusal names the error code and changes nothing. | нет |
| 79 | `i18n/forms.mjs` · `forms.tab_tax` | н | Налог | Tax | нет |
| 80 | `i18n/forms.mjs` · `forms.data_lead` | н | Внести регулярный платёж, часы, налоговое правило, цель накопления, курс, счёт или рассрочку без правки файла. | Entering a recurring payment, hours, a tax rule, a savings goal, a rate, an account or an instalment plan without editing the file. | нет |
| 81 | `i18n/forms.mjs` · `forms.f_rate_tax` | н | Ставка, % | Rate, % | нет |
| 82 | `i18n/forms.mjs` · `forms.f_tax_rule_id` | н | Правило | Rule | нет |
| 83 | `i18n/forms.mjs` · `forms.f_reserve_id` | н | Конверт (резерв) | Envelope (reserve) | нет |
| 84 | `i18n/forms.mjs` · `forms.payout_lead` | н | Записывает проведённый доход по потоку и сразу — запись в налоговый конверт по правилу на эту дату, если правило подходит. | Records the posted income for the stream and, at once, an entry into the tax envelope by the rule on that date if the rule fits. | нет |
| 85 | `i18n/forms.mjs` · `forms.tax_title` | н | Налоговое правило | Tax rule | нет |
| 86 | `i18n/forms.mjs` · `forms.tax_lead` | н | Процент от поступления откладывается в «налоговый конверт» в момент прихода дохода; на балансе счёта это ничего не меняет. | A percentage of an income is set aside into the "tax envelope" when the income arrives; the account balance does not change. | нет |
| 87 | `i18n/forms.mjs` · `forms.tax_note` | н с | Расчёт по введённым правилам, не консультация. | Calculated from the rules you entered; not advice. | да |
| 88 | `i18n/forms.mjs` · `forms.tax_none` | н | Правил пока нет. Ставку введите сами: приложение ставок не подсказывает. | There are no rules yet. Enter the rate yourself: the app does not suggest rates. | нет |
| 89 | `i18n/forms.mjs` · `forms.tax_rate` | н | {rate}, версия {version} | {rate}, version {version} | нет |
| 90 | `i18n/forms.mjs` · `forms.tax_unmarked` | н | Проверка не отмечена: срок годности правила не задан. | Review not marked: the rule has no shelf life. | нет |
| 91 | `i18n/forms.mjs` · `forms.tax_fresh` | н | Проверено {since}; срок годности {ttl} дн. | Reviewed {since}; shelf life {ttl} days. | нет |
| 92 | `i18n/forms.mjs` · `forms.tax_stale_text` | н | Правило не подтверждено с {since}: проверьте его. Числа показаны, но правило давно не проверялось. | The rule has not been confirmed since {since}: check it. The numbers are shown, but the rule has not been reviewed for a while. | нет |
| 93 | `i18n/forms.mjs` · `forms.tax_disabled_text` | н | Правило не подтверждено с {since}: числа скрыты до подтверждения или правки правила. | The rule has not been confirmed since {since}: the numbers stay hidden until it is confirmed or changed. | нет |
| 94 | `i18n/forms.mjs` · `forms.tax_hidden_numbers` | н | Числа конверта скрыты: правило не подтверждено с {since}. Расчёт «свободно» продолжается, резерв остаётся. | The envelope numbers are hidden: the rule has not been confirmed since {since}. The "free" calculation continues, the reserve stays. | нет |
| 95 | `i18n/forms.mjs` · `forms.tax_in_envelope` | н | В конверте сейчас {now}; к концу горизонта {end}. | In the envelope now: {now}; by the end of the horizon: {end}. | нет |
| 96 | `i18n/forms.mjs` · `forms.tax_confirm` | н | Подтвердить правило | Confirm the rule | нет |
| 97 | `i18n/forms.mjs` · `forms.tax_confirm_needs_ttl` | н | Подтвердить правило можно после того, как в форме ниже задан срок годности. | The rule can be confirmed once a shelf life is set in the form below. | нет |
| 98 | `i18n/forms.mjs` · `forms.tax_confirmed` | н | Правило «{name}» подтверждено: добавлена версия с сегодняшней отметкой проверки. | Rule "{name}" confirmed: a version with today's review mark was added. | нет |
| 99 | `i18n/forms.mjs` · `forms.tax_new_rule` | н | Новое правило | New rule | нет |
| 100 | `i18n/forms.mjs` · `forms.tax_no_stream` | н | нет (только по метке) | none (by tag only) | нет |
| 101 | `i18n/forms.mjs` · `forms.tax_new_reserve` | н | Создать новый налоговый конверт | Create a new tax envelope | нет |
| 102 | `i18n/forms.mjs` · `forms.tax_form_title` | н | Правило налогового конверта | Tax envelope rule | нет |
| 103 | `i18n/forms.mjs` · `forms.tax_form_lead` | н | Смена ставки добавляет версию с датой начала: прошлые версии и записанные по ним суммы не меняются. | Changing the rate adds a version with a start date: earlier versions and the amounts recorded by them do not change. | нет |
| 104 | `i18n/forms.mjs` · `forms.h_tax_name` | н | Например: налоговый конверт 20 %. | For example: tax envelope 20 %. | нет |
| 105 | `i18n/forms.mjs` · `forms.h_tax_rate` | н | Процент от поступления, число от 0 до 100. | A percentage of the income, a number from 0 to 100. | нет |
| 106 | `i18n/forms.mjs` · `forms.h_tax_tag` | н | Необязательно: метка дохода, к которой применяется правило. | Optional: an income tag the rule applies to. | нет |
| 107 | `i18n/forms.mjs` · `forms.h_tax_from` | н | С этой даты версия действует. | The version is in force from this date. | нет |
| 108 | `i18n/forms.mjs` · `forms.h_tax_ttl` | н | Через сколько дней правило нужно подтвердить. Пусто — срок не задан. | After how many days the rule must be confirmed. Empty: no shelf life. | нет |
| 109 | `i18n/forms.mjs` · `forms.tax_preview_title` | н | Что будет с конвертом (ближайшие поступления) | What happens to the envelope (nearest incomes) | нет |
| 110 | `i18n/forms.mjs` · `forms.tax_preview_row` | н | {date}: поступление {income} → в конверт сейчас {now}, по правилу {next} | {date}: income {income} → into the envelope now {now}, by the rule {next} | нет |
| 111 | `i18n/forms.mjs` · `forms.tax_preview_total` | н | Итого по этим поступлениям: сейчас {now}, по правилу {next}. | Total for these incomes: now {now}, by the rule {next}. | нет |
| 112 | `i18n/forms.mjs` · `forms.tax_preview_none` | н | Подходящих плановых поступлений в горизонте нет. | There are no suitable planned incomes in the horizon. | нет |
| 113 | `i18n/forms.mjs` · `forms.tax_preview_wait` | н | Поля не заполнены: предпросмотр конверта появится здесь. | The fields are not filled in: the envelope preview will appear here. | нет |
| 114 | `i18n/forms.mjs` · `forms.tax_saved` | н | Правило «{name}» записано. | Rule "{name}" saved. | нет |
| 115 | `i18n/forms.mjs` · `forms.th_title` | н | Налоги и часы | Taxes and hours | нет |
| 116 | `i18n/forms.mjs` · `forms.th_envelope` | н с | В конверт по правилу {rate} — {exp} (диапазон {min}–{max}). Расчёт по введённым правилам, не консультация. | Into the envelope by the rule {rate}: {exp} (range {min}–{max}). Calculated from the rules you entered; not advice. | да |
| 117 | `i18n/forms.mjs` · `forms.th_hidden` | н | В конверт по правилу {rate}: правило не подтверждено с {since}, числа скрыты до подтверждения или правки. | Into the envelope by the rule {rate}: the rule has not been confirmed since {since}, the numbers stay hidden until it is confirmed or changed. | нет |
| 118 | `i18n/forms.mjs` · `forms.pend_title` | н | Проведено, но в конверт не записано | Posted, but not recorded in the envelope | нет |
| 119 | `i18n/forms.mjs` · `forms.pend_income` | н | Доход {amount} от {date}: в конверт. | Income {amount} on {date}: into the envelope. | нет |
| 120 | `i18n/forms.mjs` · `forms.pend_payment` | н | Платёж от {date}: из конверта высвобождается {amount}. | Payment on {date}: {amount} is released from the envelope. | нет |
| 121 | `i18n/forms.mjs` · `forms.pend_write` | н | Записать в конверт ({sum}) | Record in the envelope ({sum}) | нет |
| 122 | `i18n/forms.mjs` · `forms.liq_line_reserve` | н | Резервы (налоговый конверт и накопления): {value} | Reserves (tax envelope and savings): {value} | нет |
| 123 | `i18n/forms.mjs` · `forms.liq_note` | с | Запас не входит в «можно потратить». Долю актива и криптовалюты задаёте вы: по умолчанию 0, приложение её не придумывает. | The stock is not part of "safe to spend". The share of an asset or a cryptocurrency is yours to set: 0 by default, the app does not invent it. | нет |
| 124 | `i18n/forms.mjs` · `forms.inst_form_lead` | с | График и вердикт видны до записи. Перенос платежа меняет только его дату. | The schedule and the verdict are shown before saving. Moving a payment changes only its date. | нет |
| 125 | `i18n/forms.mjs` · `forms.inst_wait` | с | Поля не заполнены: график и вердикт появятся здесь. | The fields are not filled in: the schedule and the verdict will appear here. | нет |
| 126 | `i18n/forms.mjs` · `forms.inst_verdict` | с | Вердикт: {verdict}; минимум «свободно» после покупки {min}. | Verdict: {verdict}; the minimum of "free" after the purchase is {min}. | нет |
| 127 | `i18n/forms.mjs` · `forms.inst_insufficient` | с | Вердикт пока недоступен: данных не хватает (см. «Готовность данных» на обзоре). | The verdict is not available yet: not enough data (details under "Data readiness" on the overview). | нет |
| 128 | `i18n/forms.mjs` · `forms.inst_note` | с | График по модели не равен договору банка: дни, комиссии и плавающая ставка не учтены. Расчёт по введённым данным, не консультация. | The schedule by the model is not the bank contract: days, fees and a floating rate are not counted. Calculated from the data you entered; not advice. | да |
| 129 | `i18n/import.mjs` · `import.hl_intro` | с | Поддерживается подмножество hledger: счета, проводки с двумя активными ногами, якоря «=», курсы «P». Цена «@» и «@@» и больше двух активных ног (assets, liabilities) не переносятся: журнал с ними отклоняется целиком. | A subset of hledger is supported: accounts, postings with two active legs, "=" anchors, "P" rates. A price ("@" and "@@") and more than two active legs (assets, liabilities) are not carried over: a journal with them is rejected as a whole. | нет |
| 130 | `i18n/mfeed.mjs` · `mfeed.closed` | т | Окно прогноза на {days} дн. закрыто сверкой остатка. В метрики на устройстве записано: ошибка минимума {error}, {inside}. Сумм и дат в метриках нет. | The {days}-day forecast window is closed by the balance check. Recorded in the on-device metrics: minimum error {error}, {inside}. The metrics hold no amounts or dates. | нет |
| 131 | `i18n/mfeed.mjs` · `mfeed.closed_no_error` | т | Окно прогноза на {days} дн. закрыто сверкой остатка. Ошибку минимума определить нельзя (прогнозный минимум равен нулю); в метрики записано только покрытие: {inside}. Сумм и дат в метриках нет. | The {days}-day forecast window is closed by the balance check. The minimum error cannot be defined (the forecast minimum is zero); only coverage is recorded: {inside}. The metrics hold no amounts or dates. | нет |
| 132 | `i18n/probe.mjs` · `probe.disclaimer` | с т | Расчёт по введённым данным и правилам, не консультация. Цифры — гипотезы-бюджеты (ADR-014), а не обещания продукту; публикуется только измеренное, с n, датой и устройством. Страница ничего не измеряет, пока вы не нажмёте кнопку. | A calculation from the data and rules you enter, not advice. The figures are budget hypotheses (ADR-014), not promises to the product; only what was measured is published, with n, date and device. The page measures nothing until you press the button. | да |
| 133 | `i18n/quality.mjs` · `quality.nav` | т | Качество прогноза | Forecast quality | нет |
| 134 | `i18n/quality.mjs` · `quality.title` | т | Качество прогноза | Forecast quality | нет |
| 135 | `i18n/quality.mjs` · `quality.disclaimer` | с т | Расчёт по введённым данным и правилам, не консультация. Вероятностные блоки — эксперимент и выключены по умолчанию. | Calculated from the data and rules you entered; not advice. The probabilistic blocks are an experiment and are off by default. | да |
| 136 | `i18n/quality.mjs` · `quality.badge` | т | Эксперимент, не обещание | Experiment, not a promise | нет |
| 137 | `i18n/quality.mjs` · `quality.synth_banner` | т | Синтетика: журналы сгенерированы программой — это не ваши данные и не данные пользователей. Цифры показывают, как работает проверка, а не качество прогноза для реальных людей. | Synthetic: the journals were generated by a program — they are not your data and not users’ data. The numbers show how the check works, not how good the forecast is for real people. | нет |
| 138 | `i18n/quality.mjs` · `quality.expected_note` | с | Оценка для сравнения, а не режим расчёта: вердикты и числа Q1/Q3 она не меняет. | An estimate for comparison, not a calculation mode: it does not change verdicts or the Q1/Q3 numbers. | нет |
| 139 | `i18n/quality.mjs` · `quality.exp_title` | т | Эксперимент: вероятностная полоса и «при уверенности α» | Experiment: probability band and “at confidence α” | нет |
| 140 | `i18n/quality.mjs` · `quality.exp_lead` | с т | Полоса P10–P90 и оценка «при уверенности α максимум X» выключены по умолчанию и включаются только явным согласием ниже. Они строятся по вашей истории платежей, не меняют вердикты («выдерживает», «хрупко», «впритык», «не хватает») и числа Q1/Q3 и могут ошибаться. При малом числе наблюдений вместо процента будет только счёт «в k из n»; без истории — отказ. | The P10–P90 band and the “at confidence α, at most X” estimate are off by default and are turned on only by the explicit consent below. They are built from your payment history, do not change verdicts (“holds”, “fragile”, “tight”, “short”) or the Q1/Q3 numbers, and may be wrong. With few observations you get only a count “in k of n” instead of a percentage; with no history — a refusal. | нет |
| 141 | `i18n/quality.mjs` · `quality.agree_label` | т | Понимаю: это эксперимент, а не обещание. Цифры строятся по моей истории платежей и могут ошибаться. | I understand: this is an experiment, not a promise. The numbers are built from my payment history and may be wrong. | нет |
| 142 | `i18n/quality.mjs` · `quality.agree_needed` | т | Эксперимент включается только после отметки согласия. | The experiment turns on only after the consent box is ticked. | нет |
| 143 | `i18n/quality.mjs` · `quality.enable` | т | Включить эксперимент | Turn the experiment on | нет |
| 144 | `i18n/quality.mjs` · `quality.disable` | т | Выключить эксперимент | Turn the experiment off | нет |
| 145 | `i18n/quality.mjs` · `quality.enabled_note` | т | Эксперимент включён. Выключить можно кнопкой «Выключить эксперимент». | The experiment is on. It is switched back with “Turn the experiment off”. | нет |
| 146 | `i18n/quality.mjs` · `quality.disabled_note` | т | Эксперимент выключен. | The experiment is off. | нет |
| 147 | `i18n/quality.mjs` · `quality.band_title` | т | Коридор остатка (эксперимент) | Balance band (experiment) | нет |
| 148 | `i18n/quality.mjs` · `quality.refuse_no_buffer` | т | Буфер не задан: оценку по уверенности построить нельзя, как и ответ на экране «Купить». | No buffer is set: the confidence estimate cannot be built, just like the answer on the “Buy” screen. | нет |
| 149 | `i18n/quality.mjs` · `quality.card_title` | т | Коридор остатка (эксперимент) | Balance band (experiment) | нет |
| 150 | `i18n/quality.mjs` · `quality.card_run` | т | Коридор ещё не посчитан: он считается на экране «Качество прогноза». | The band is not calculated yet: it is calculated on the “Forecast quality” screen. | нет |
| 151 | `i18n/quality.mjs` · `quality.card_go` | т | Открыть «Качество прогноза» | Open “Forecast quality” | нет |
| 152 | `i18n/quality.mjs` · `quality.buy_title` | т | При уверенности α: максимум суммы | At confidence α: maximum amount | нет |
| 153 | `i18n/quality.mjs` · `quality.buy_lead` | с т | Оценка наибольшей суммы покупки, при которой буфер сохраняется в выбранной доле прошлых случаев. Это эксперимент: он не заменяет ответ «могу ли я купить». | An estimate of the largest purchase amount for which the buffer holds in the chosen share of past cases. This is an experiment: it does not replace the “can I buy it” answer. | нет |
| 154 | `i18n/quality.mjs` · `quality.buy_conf` | т | Уверенность | Confidence | нет |
| 155 | `i18n/quality.mjs` · `quality.buy_enum` | т | При уверенности {c} % максимум {x}{label}: по {n} прошлым случаям. | At confidence {c} %, at most {x}{label}: from {n} past cases. | нет |
| 156 | `i18n/quality.mjs` · `quality.buy_sample` | т | При уверенности {c} % максимум {x}{label} (n = {n} наблюдений). | At confidence {c} %, at most {x}{label} (n = {n} observations). | нет |
| 157 | `i18n/quality.mjs` · `quality.buy_verdict_note` | с | Это отдельная оценка. Ответ «могу ли я купить» на {date} считается детерминированно на экране «Купить» и от неё не зависит. | This is a separate estimate. The “can I buy it” answer for {date} is calculated deterministically on the “Buy” screen and does not depend on it. | нет |
| 158 | `i18n/quarantine.mjs` · `quarantine.kind_tax_rules` | н | Налоговые правила | Tax rules | нет |
| 159 | `i18n/reconcile.mjs` · `reconcile.disclaimer` | с | Расчёт по введённым данным и правилам, не консультация. Решения сверки можно отменить кнопкой «Отменить». | Calculated from the data and rules you entered; not advice. Reconcile decisions can be undone with the “Undo” button. | да |
| 160 | `i18n/reserveui.mjs` · `reserveui.cards_title` | н | Резервы: остаток и расчёт | Reserves: balance and calculation | нет |
| 161 | `i18n/reserveui.mjs` · `reserveui.cards_lead` | н с | По каждому резерву: сколько в нём сейчас, что делать с остатком после срока и как посчитано. Расчёт по введённым данным и правилам, не консультация. | For each reserve: how much is in it now, what to do with the balance after the due date, and how it is calculated. Calculated from the data and rules you entered; not advice. | да |
| 162 | `i18n/reserveui.mjs` · `reserveui.now_line` | н | Сейчас в резерве {now}; к концу горизонта {end}. | In the reserve now: {now}; by the end of the horizon: {end}. | нет |
| 163 | `i18n/reserveui.mjs` · `reserveui.hidden_line` | н | Числа скрыты: правило не подтверждено с {since}; они вернутся после подтверждения или правки правила. | The numbers are hidden: the rule has not been confirmed since {since}; they return once the rule is confirmed or changed. | нет |
| 164 | `i18n/reserveui.mjs` · `reserveui.residual_text` | н | Срок {due} наступил, платёж по резерву был, а в резерве записано {sum}. Автоматически остаток не освобождается: он освобождается вручную, когда деньги больше не нужны под этот платёж. | The due date {due} has arrived and the reserve payment was made, but {sum} is still recorded in the reserve. The balance is not released automatically: it is released by hand when the money is no longer needed for this payment. | нет |
| 165 | `i18n/reserveui.mjs` · `reserveui.overdue_text` | н | Срок {due} наступил, а платёж, привязанный к резерву, не найден; в резерве записано {sum}. Если платёж уже прошёл мимо резерва или больше не нужен, остаток можно освободить вручную. | The due date {due} has arrived and no payment linked to the reserve was found; {sum} is recorded in the reserve. If the payment went through without the reserve or is no longer needed, you can release the balance by hand. | нет |
| 166 | `i18n/reserveui.mjs` · `reserveui.release_btn` | н | Освободить остаток | Release the balance | нет |
| 167 | `i18n/reserveui.mjs` · `reserveui.release_aria` | н | Освободить остаток {sum} резерва «{name}» | Release the balance {sum} of the reserve "{name}" | нет |
| 168 | `i18n/reserveui.mjs` · `reserveui.release_hint` | н | Будет записано: −{sum}, источник «вручную». «Отменить» вернёт запись; повтор ничего не изменит. | This will record: −{sum}, source "manual". “Undo” takes the entry back; repeating changes nothing. | нет |
| 169 | `i18n/reserveui.mjs` · `reserveui.release_note` | н | Освобождается весь записанный в резерве остаток. Если платёж ещё не отражён записью (карточка «Проведено, но в конверт не записано»), его сначала нужно записать: тогда освободится только то, что действительно осталось. | The whole balance recorded in the reserve is released. If the payment is not yet reflected by an entry (the card "Posted, but not recorded in the envelope"), it has to be recorded first: then only what is really left will be released. | нет |
| 170 | `i18n/reserveui.mjs` · `reserveui.payments_line` | н | Платежи по резерву: {list}. | Payments from the reserve: {list}. | нет |
| 171 | `i18n/reserveui.mjs` · `reserveui.payments_more` | н | ещё {n} ранее | {n} more earlier | нет |
| 172 | `i18n/reserveui.mjs` · `reserveui.released` | н | Остаток резерва «{name}» освобождён: {sum}. | The balance of the reserve "{name}" is released: {sum}. | нет |
| 173 | `i18n/reserveui.mjs` · `reserveui.release_nothing` | н | Освобождать нечего: в резерве «{name}» нет остатка. | Nothing to release: the reserve "{name}" has no balance. | нет |
| 174 | `i18n/reserveui.mjs` · `reserveui.release_failed` | н | Остаток не освобождён (код {code}). Данные не изменены. | The balance was not released (code {code}). Your data is unchanged. | нет |
| 175 | `i18n/reserveui.mjs` · `reserveui.how_btn` | н | Как посчитано | How it is calculated | нет |
| 176 | `i18n/reserveui.mjs` · `reserveui.how_aria` | н | Как посчитано: {name} | How it is calculated: {name} | нет |
| 177 | `i18n/reserveui.mjs` · `reserveui.rules_title` | н | Срок годности налоговых правил | Shelf life of tax rules | нет |
| 178 | `i18n/reserveui.mjs` · `reserveui.rules_lead` | н | Правило, которое давно не проверяли, может не соответствовать вашему случаю. После срока годности числа конверта показываются с предупреждением, после двух сроков — заменяются текстом. Ставок по умолчанию нет: правило вводите вы. | A rule that has not been reviewed for a long time may not fit your case. After the shelf life the envelope numbers carry a warning, after two shelf lives they are replaced by text. There are no default rates: you enter the rule. | нет |
| 179 | `i18n/reserveui.mjs` · `reserveui.rule_fresh` | н | Проверено {since}; срок годности {ttl} дн., прошло {age} дн. | Reviewed {since}; shelf life {ttl} days, {age} days passed. | нет |
| 180 | `i18n/reserveui.mjs` · `reserveui.rule_unmarked` | н | Проверка не отмечена: срок годности правила не задан. | Review not marked: the rule has no shelf life. | нет |
| 181 | `i18n/reserveui.mjs` · `reserveui.rule_no_ttl` | н | Проверено {since}; срок годности не задан, поэтому возраст правила не отслеживается. Срок задаётся в «Формы данных → Налог». | Reviewed {since}; no shelf life is set, so the age of the rule is not tracked. It is set in "Data forms → Tax". | нет |
| 182 | `i18n/reserveui.mjs` · `reserveui.rule_stale` | н | Правило не подтверждено с {since} (прошло {age} дн. при сроке {ttl} дн.): проверьте его. Числа показаны, но правило давно не проверялось. | The rule has not been confirmed since {since} ({age} days passed, shelf life {ttl} days): check it. The numbers are shown, but the rule has not been reviewed for a while. | нет |
| 183 | `i18n/reserveui.mjs` · `reserveui.rule_disabled` | н | Правило не подтверждено с {since} (прошло {age} дн. при сроке {ttl} дн.): числа конверта скрыты до подтверждения или правки правила. | The rule has not been confirmed since {since} ({age} days passed, shelf life {ttl} days): the envelope numbers stay hidden until the rule is confirmed or changed. | нет |
| 184 | `i18n/reserveui.mjs` · `reserveui.rule_confirm` | н | Подтвердить правило | Confirm the rule | нет |
| 185 | `i18n/reserveui.mjs` · `reserveui.rule_confirm_aria` | н | Подтвердить правило «{name}» | Confirm the rule "{name}" | нет |
| 186 | `i18n/reserveui.mjs` · `reserveui.rule_needs_ttl` | н | Срок годности не задан: подтвердить правило можно после того, как он задан в «Формы данных → Налог». | No shelf life is set: the rule can be confirmed once it is set in "Data forms → Tax". | нет |
| 187 | `i18n/reserveui.mjs` · `reserveui.rule_confirmed` | н | Правило «{name}» подтверждено: добавлена версия с сегодняшней отметкой проверки. | Rule "{name}" confirmed: a version with today's review mark was added. | нет |
| 188 | `i18n/reserveui.mjs` · `reserveui.rule_confirmed_until` | н | Правило «{name}» подтверждено до {until}: с этой даты действует уже записанная версия правила, она не менялась. | Rule "{name}" confirmed until {until}: from that date the version already recorded applies, it was not changed. | нет |
| 189 | `i18n/reserveui.mjs` · `reserveui.rule_failed` | н | Правило не подтверждено (код {code}). Данные не изменены. | The rule was not confirmed (code {code}). Your data is unchanged. | нет |
| 190 | `i18n/reserveui.mjs` · `reserveui.pend_masked` | н | Доход от {date}: сумма скрыта, правило не подтверждено с {since}. | Income of {date}: the amount is hidden, the rule has not been confirmed since {since}. | нет |
| 191 | `i18n/reserveui.mjs` · `reserveui.pend_write_masked` | н | Записать в конверт (суммы скрыты) | Record in the envelope (amounts hidden) | нет |
| 192 | `i18n/reserveui.mjs` · `reserveui.liq_masked` | н | Резервы (налоговый конверт и накопления): сумма скрыта, правило не подтверждено с {since}; сумма вернётся после подтверждения или правки правила. | Reserves (tax envelope and savings): the amount is hidden, the rule has not been confirmed since {since}; it returns once the rule is confirmed or changed. | нет |
| 193 | `i18n/reserveui.mjs` · `reserveui.how_title` | н | Как посчитано: {name} | How it is calculated: {name} | нет |
| 194 | `i18n/reserveui.mjs` · `reserveui.how_lead_tax` | н с | Сколько будет в конверте к {date}: то, что в нём сейчас, плюс отложенное с поступлений по вашему правилу, минус платежи из конверта. Расчёт по введённым правилам, не консультация. | What the envelope will hold by {date}: what is in it now, plus what is set aside from receipts by your rule, minus payments from the envelope. Calculated from the rules you entered; not advice. | да |
| 195 | `i18n/reserveui.mjs` · `reserveui.how_lead_sinking` | н | Сколько будет в резерве к {date}: то, что в нём сейчас, плюс взносы по графику, минус платежи из резерва. | What the reserve will hold by {date}: what is in it now, plus contributions by the schedule, minus payments from the reserve. | нет |
| 196 | `i18n/reserveui.mjs` · `reserveui.how_hidden` | н | Числа скрыты: правило не подтверждено с {since}; они вернутся после подтверждения или правки правила. Расчёт «свободно» при этом продолжается, резерв остаётся. | The numbers are hidden: the rule has not been confirmed since {since}; they return once the rule is confirmed or changed. The "free" calculation continues, the reserve stays. | нет |
| 197 | `i18n/reserveui.mjs` · `reserveui.how_table` | н | Из чего сложился остаток резерва к концу горизонта | What makes up the reserve balance at the end of the horizon | нет |
| 198 | `i18n/reserveui.mjs` · `reserveui.how_col_date` | н | Дата | Date | нет |
| 199 | `i18n/reserveui.mjs` · `reserveui.how_col_what` | н | Что | What | нет |
| 200 | `i18n/reserveui.mjs` · `reserveui.how_col_amount` | н | Сумма | Amount | нет |
| 201 | `i18n/reserveui.mjs` · `reserveui.how_row_start` | н | Сейчас в резерве | In the reserve now | нет |
| 202 | `i18n/reserveui.mjs` · `reserveui.how_row_alloc` | н | Поступление «{name}» {gross} → правило «{rule}», версия {ver}: {gross} × {rate} | Receipt "{name}" {gross} → rule "{rule}", version {ver}: {gross} × {rate} | нет |
| 203 | `i18n/reserveui.mjs` · `reserveui.how_row_alloc_plain` | н | Отложено с поступления | Set aside from a receipt | нет |
| 204 | `i18n/reserveui.mjs` · `reserveui.how_row_contrib` | н | Взнос по графику | Contribution by the schedule | нет |
| 205 | `i18n/reserveui.mjs` · `reserveui.how_row_release` | н | Платёж «{name}» {payment}: из резерва высвобождается {released} | Payment "{name}" {payment}: {released} is released from the reserve | нет |
| 206 | `i18n/reserveui.mjs` · `reserveui.how_row_release_plain` | н | Платёж из резерва: высвобождается {released} | Payment from the reserve: {released} is released | нет |
| 207 | `i18n/reserveui.mjs` · `reserveui.how_true_up` | н | Ещё {true_up} уходит из свободных денег. | Another {true_up} comes out of free money. | нет |
| 208 | `i18n/reserveui.mjs` · `reserveui.how_row_end` | н | К концу горизонта | By the end of the horizon | нет |
| 209 | `i18n/reserveui.mjs` · `reserveui.how_sum_ok` | н | Сумма строк {sum} равна числу «к концу горизонта» {end}: сходится. | The rows add up to {sum}, equal to the "by the end of the horizon" number {end}: it adds up. | нет |
| 210 | `i18n/reserveui.mjs` · `reserveui.how_sum_bad` | н | Сумма строк {sum} не равна числу «к концу горизонта» {end}: не сходится. | The rows add up to {sum}, not equal to the "by the end of the horizon" number {end}: it does not add up. | нет |
| 211 | `i18n/reserveui.mjs` · `reserveui.how_no_flow` | н | В горизонте нет ни поступлений под правило, ни взносов, ни платежей: остаток не меняется. | There are no receipts under the rule, no contributions and no payments within the horizon: the balance does not change. | нет |
| 212 | `i18n/reserveui.mjs` · `reserveui.how_rec_title` | н | Уже записано в резерве | Already recorded in the reserve | нет |
| 213 | `i18n/reserveui.mjs` · `reserveui.how_rec_start` | н | Начальная сумма на {date}: {amount} | Starting amount on {date}: {amount} | нет |
| 214 | `i18n/reserveui.mjs` · `reserveui.how_rec_row` | н | {date}: {amount} ({source}) | {date}: {amount} ({source}) | нет |
| 215 | `i18n/reserveui.mjs` · `reserveui.src_income` | н | с поступления | from a receipt | нет |
| 216 | `i18n/reserveui.mjs` · `reserveui.src_schedule` | н | взнос | contribution | нет |
| 217 | `i18n/reserveui.mjs` · `reserveui.src_manual` | н | вручную | manual | нет |
| 218 | `i18n/reserveui.mjs` · `reserveui.src_release` | н | высвобождение | release | нет |
| 219 | `i18n/reserveui.mjs` · `reserveui.how_alloc_title` | н | Расчёт отложенных сумм | Calculation of the amounts set aside | нет |
| 220 | `i18n/reserveui.mjs` · `reserveui.how_alloc_head` | н | Поступление {date} «{name}» | Receipt of {date} "{name}" | нет |
| 221 | `i18n/reserveui.mjs` · `reserveui.how_alloc_income` | н | Сумма поступления до удержаний (gross): {gross}. | Receipt amount before deductions (gross): {gross}. | нет |
| 222 | `i18n/reserveui.mjs` · `reserveui.how_alloc_rule` | н | Правило «{rule}», версия {ver}, ставка {rate}, округление: {rounding}. | Rule "{rule}", version {ver}, rate {rate}, rounding: {rounding}. | нет |
| 223 | `i18n/reserveui.mjs` · `reserveui.how_alloc_age` | н | Возраст правила: проверено {since}, прошло {age} дн. при сроке {ttl} дн. — {state}. | Rule age: reviewed {since}, {age} days passed, shelf life {ttl} days — {state}. | нет |
| 224 | `i18n/reserveui.mjs` · `reserveui.how_alloc_unmarked` | н | Возраст правила: проверка не отмечена. | Rule age: review not marked. | нет |
| 225 | `i18n/reserveui.mjs` · `reserveui.how_alloc_formula` | н | Формула: mul_div({gross_minor}, {rate_bp}, 10000, {mode}) = {result_minor} (в минимальных единицах валюты) → {result}. | Formula: mul_div({gross_minor}, {rate_bp}, 10000, {mode}) = {result_minor} (in minor currency units) → {result}. | нет |
| 226 | `i18n/reserveui.mjs` · `reserveui.how_alloc_mismatch` | н | Сумма по формуле не совпала с расчётом страницы: проверьте данные. | The amount by the formula does not match the page calculation: check your data. | нет |
| 227 | `i18n/reserveui.mjs` · `reserveui.how_foot` | н | Режим «{mode}» · расчёт {hash} | Mode "{mode}" · calculation {hash} | нет |
| 228 | `i18n/reserveui.mjs` · `reserveui.close` | н | Закрыть | Close | нет |
| 229 | `i18n/scenarios.mjs` · `scenarios.pv_row_sts` | с | Можно потратить | Spendable amount | нет |
| 230 | `i18n/scenarios.mjs` · `scenarios.pv_note` | с | «Можно потратить» — до {date}, как на «Обзоре». Числа — расчёт по введённым данным. | The spendable amount is up to {date}, as on the “Overview”. The numbers are a calculation from the data you entered. | нет |
| 231 | `i18n/scenarios.mjs` · `scenarios.why_btn_plan` | с | Почему вердикт по плану | Why this verdict as planned | нет |
| 232 | `i18n/scenarios.mjs` · `scenarios.why_btn_worse` | с | Почему вердикт «если хуже» | Why this verdict if worse | нет |
| 233 | `i18n/scenarios.mjs` · `scenarios.why_btn_sts` | с | Почему «можно потратить» | Why this spendable amount | нет |
| 234 | `i18n/scenarios.mjs` · `scenarios.sts_why_title` | с | Почему такое «можно потратить» | Why this spendable amount | нет |
| 235 | `i18n/scenarios.mjs` · `scenarios.sts_why_lead` | с | Режим: {mode}. До {date} минимум свободных денег {min} достигается {at}; можно потратить {value}. | Mode: {mode}. Until {date} the lowest free money {min} is reached on {at}; spendable {value}. | нет |
| 236 | `i18n/scenarios.mjs` · `scenarios.sts_why_chain` | с | Из чего сложилось «можно потратить» | What the spendable amount is made of | нет |
| 237 | `i18n/scenarios.mjs` · `scenarios.verdict_why_title` | с | Почему такой вердикт: {mode} | Why this verdict: {mode} | нет |
| 238 | `i18n/scenarios.mjs` · `scenarios.verdict_status` | с | Вердикт | Verdict | нет |
| 239 | `i18n/settings.mjs` · `settings.buffer_now_unset` | с | Буфер не задан: прогноз и волны считаются с буфером 0, а вердикт и «можно потратить» не отвечают. | The buffer is not set: the forecast and waves use a buffer of 0, while the verdict and "can I spend" do not answer. | нет |
| 240 | `i18n/settings.mjs` · `settings.buffer_hint` | с | Подсказка: {value} — расходы за {days} дн. по средним последних 90 дней (всего исходящих за 90 дней: {outflow}). Подсказка — не вердикт: число задаёте вы. | Hint: {value} — {days} days of spending at the average of the last 90 days (total outflow over 90 days: {outflow}). The hint is not a verdict: you set the number. | нет |
| 241 | `i18n/settings.mjs` · `settings.l_dcur` | с | В этой валюте считаются «свободно», узкая точка и вердикт. Суммы в других валютах переводятся в неё по курсам, которые вы ввели сами (ничего не берётся из сети). | The "free to spend" figure, the narrowest point and the verdict are calculated in this currency. Amounts in other currencies are converted into it with the rates you entered yourself (nothing is fetched from the network). | нет |
| 242 | `i18n/settings.mjs` · `settings.e_dcur_reserve` | н | Есть резерв в прежней валюте решения (конверт или накопление). Пока он такой, расчёт в другой валюте не строится: данные не изменены. | There is a reserve in the previous decision currency (an envelope or a savings goal). While it stays that way, the calculation cannot be built in another currency: your data is unchanged. | нет |
| 243 | `i18n/settings.mjs` · `settings.rd_verdict_on` | с | Вердикт «можно ли купить» и «можно потратить» доступны. | The "can I afford it" verdict and "can I spend" are available. | нет |
| 244 | `i18n/settings.mjs` · `settings.rd_verdict_off` | с | Вердикт и «можно потратить» скрыты: {reasons}. | The verdict and "can I spend" are hidden: {reasons}. | нет |
| 245 | `i18n/settings.mjs` · `settings.gt_other` | т | данных недостаточно | not enough data | нет |
| 246 | `i18n/showcase.mjs` · `showcase.nav_promises` | т | Обещаем / не обещаем | We promise / we do not | нет |
| 247 | `i18n/showcase.mjs` · `showcase.tax_note` | н с | Расчёт по введённым данным и правилам, не консультация. | Calculated from the data and rules you entered; not advice. | да |
| 248 | `i18n/showcase.mjs` · `showcase.st_hint` | с | Знаков после запятой: {exp}. Пустое поле — показать только «можно потратить сегодня». | Decimal places: {exp}. An empty field shows only "can spend today". | нет |
| 249 | `i18n/showcase.mjs` · `showcase.st_can_spend` | с | Можно потратить сегодня: | Can spend today: | нет |
| 250 | `i18n/showcase.mjs` · `showcase.st_no_verdict` | с | Для этой суммы вердикта нет: нужны данные в горизонте прогноза. | There is no verdict for this amount: it needs data inside the forecast horizon. | нет |
| 251 | `i18n/showcase.mjs` · `showcase.st_time` | т | Расчёт и показ заняли {ms}. Цель — не больше {target} с на эталонном устройстве; пока это цель, а не обещание: здесь замер на вашем устройстве. | Calculation and display took {ms}. The target is at most {target} s on a reference device; for now it is a target, not a promise: this is a measurement on your device. | нет |
| 252 | `i18n/showcase.mjs` · `showcase.ld_lead` | с | Какая сумма на выбранную дату получает какой вердикт. Границы берутся из «максимума покупки» движка: с буфером и без него, по плану и если хуже. | Which amount gets which verdict on the chosen date. The limits come from the engine's "maximum purchase": with and without the buffer, as planned and if worse. | нет |
| 253 | `i18n/showcase.mjs` · `showcase.ld_own` | с | Сумма {amount}: {verdict}. | Amount {amount}: {verdict}. | нет |
| 254 | `i18n/showcase.mjs` · `showcase.ld_svg_label` | с | Полоса вердиктов по суммам: выдерживает, хрупко, впритык, не хватает; границы подписаны под полосой. | Bar of verdicts by amount: holds, fragile, tight, short; the limits are labelled under the bar. | нет |
| 255 | `i18n/showcase.mjs` · `showcase.ld_rungs_caption` | с | Диапазоны сумм по вердиктам | Amount ranges by verdict | нет |
| 256 | `i18n/showcase.mjs` · `showcase.ld_col_verdict` | с | Вердикт | Verdict | нет |
| 257 | `i18n/showcase.mjs` · `showcase.ld_samples_caption` | с | Вердикт на границе и на минимальную единицу выше | Verdict at the limit and one minimal unit above it | нет |
| 258 | `i18n/showcase.mjs` · `showcase.ld_gate` | с | Данных мало для вердикта: лестница не строится. Нужны заданный буфер и сверенный остаток. | Not enough data for a verdict: the ladder is not built. A set buffer and a reconciled balance are needed. | нет |
| 259 | `i18n/showcase.mjs` · `showcase.gv_treadmill_verdict` | с | Вердикт для покупки 300,00 € на 12 октября | Verdict for a €300.00 purchase on October 12 | нет |
| 260 | `i18n/showcase.mjs` · `showcase.gh_reserve_close_end` | н | Налоговый конверт и годовая страховка вместе на последний день горизонта. | The tax envelope and the annual insurance together on the last day of the horizon. | нет |
| 261 | `i18n/showcase.mjs` · `showcase.pr_title` | т | Обещаем / не обещаем | We promise / we do not | нет |
| 262 | `i18n/showcase.mjs` · `showcase.pr_promise` | т | Обещаем | We promise | нет |
| 263 | `i18n/showcase.mjs` · `showcase.pr_non_promise` | т | Не обещаем | We do not promise | нет |
| 264 | `i18n/showcase.mjs` · `showcase.cl_gate` | с | Вердикт и «можно потратить» отвечают только при достаточных данных; иначе показано «данных мало». | The verdict and "can spend" answer only when the data is sufficient; otherwise "not enough data" is shown. | нет |
| 265 | `i18n/showcase.mjs` · `showcase.cl_v0_same_engine` | с | Страница-калькулятор v0 считает тем же движком: на данных, эквивалентных G-001, вердикт и числа те же. | The v0 calculator page uses the same engine: on data equivalent to G-001 the verdict and the numbers are the same. | нет |
| 266 | `i18n/showcase.mjs` · `showcase.cl_template_no_rates` | н с | Шаблон-скелет не содержит сумм и ставок; налоговые правила вы вводите сами, расчёт по введённым правилам, не консультация. | The skeleton template has no amounts or rates; tax rules are entered by you, calculated from the rules you entered; not advice. | да |
| 267 | `i18n/showcase.mjs` · `showcase.cl_accuracy` | т | Не обещаем точность прогноза: число — расчёт по введённым данным, оно меняется, если данные неполны. | We do not promise forecast accuracy: a number is a calculation from the data you entered and it changes when the data is incomplete. | нет |
| 268 | `i18n/showcase.mjs` · `showcase.cl_advice` | н с | Не даём налоговых, юридических и инвестиционных советов: налоговые правила — ваши данные, расчёт по введённым правилам, не консультация. | We give no tax, legal or investment advice: tax rules are your data, calculated from the rules you entered; not advice. | да |
| 269 | `i18n/showcase.mjs` · `showcase.cl_migration` | т | Не обещаем, что при переносе данных не будет ошибок: после загрузки показывается отчёт — что распознано, отклонено и пропущено как повтор. | We do not promise that moving data has no errors: after loading, a report shows what was recognised, rejected and skipped as a repeat. | нет |
| 270 | `i18n/showcase.mjs` · `showcase.cl_first_minutes` | т | Время до первого прогноза не заявляем: измерения на других людях нет. | We do not state the time to the first forecast: there is no measurement on other people. | нет |
| 271 | `i18n/showcase.mjs` · `showcase.cl_buy_advice` | с т | Вердикт — оценка по вашим данным, а не рекомендация покупать или не покупать. | The verdict is an estimate from your data, not a recommendation to buy or not to buy. | да |
| 272 | `i18n/showcase.mjs` · `showcase.cl_human_review_pending` | с т | Юридическое ревью формулировок и вычитка RU/EN не выполнены: они ждут людей, готовности мы не заявляем. | Legal review of the wording and proofreading of RU/EN are not done: they wait for people, and we do not claim readiness. | нет |
| 273 | `i18n/showcase.mjs` · `showcase.cl_prob_off_by_default` | с т | Вероятностная полоса и «при уверенности α максимум X» выключены по умолчанию, включаются лишь по вашему явному согласию и не меняют вердикты и числа Q1/Q3. | The probability band and “at confidence α, at most X” are off by default, are turned on only with your explicit consent and do not change the verdicts or the Q1/Q3 numbers. | нет |
| 274 | `i18n/showcase.mjs` · `showcase.cl_prob_not_promise` | т | Вероятностные оценки — эксперимент, а не обещание: при малом числе наблюдений вместо процента будет счёт «в k из n», без истории — отказ. | Probability estimates are an experiment, not a promise: with few observations you get a count “in k of n” instead of a percentage, and with no history a refusal. | нет |
| 275 | `i18n/showcase.mjs` · `showcase.rp_buffer_unset` | с | Буфер не задан: вердикт и «можно потратить» не отвечают. | The buffer is not set: the verdict and "can spend" do not answer. | нет |
| 276 | `i18n/showcase.mjs` · `showcase.rp_can_spend` | с | Можно потратить сегодня | Can spend today | нет |
| 277 | `i18n/start.mjs` · `start.lead` | т | Четыре шага и буфер. Прогноз появится, когда движок сочтёт данные готовыми (ступень 3 из 4); шаги можно пропускать и возвращаться к ним. Сколько это займёт времени, мы не обещаем: оно зависит от ваших данных. | Four steps and a buffer. The forecast appears once the engine counts the data as ready (level 3 of 4); you can skip steps and come back to them. We do not promise how long it takes: it depends on your data. | нет |
| 278 | `i18n/start.mjs` · `start.disclaimer` | н с | Расчёт по введённым данным и правилам, не консультация. Налоги — только правила, которые вводите вы. | Calculated from the data and rules you enter; not advice. Taxes: only the rules you enter yourself. | да |
| 279 | `i18n/start.mjs` · `start.s5_lead` | с | Буфер не входит в готовность данных, но без него ответ «могу ли я купить» не появится. Ноль допустим: тогда буфер задан и равен нулю. | The buffer is not part of data readiness, but without it the “can I buy this” answer does not appear. Zero is allowed: then the buffer is set and equals zero. | нет |
| 280 | `i18n/start.mjs` · `start.h_buffer` | с т | Подсказка по вашим расходам: {value}. Это подсказка, а не рекомендация. | A hint from your spending: {value}. It is a hint, not a recommendation. | да |
| 281 | `i18n/start.mjs` · `start.obl_progress_ok` | т | Платежей добавлено: {n}. Для шага достаточно {need}; можно переходить дальше. | Payments added: {n}. {need} is enough for this step; you can move on. | нет |
| 282 | `i18n/start.mjs` · `start.fc_verdict_on` | с | Ответ «могу ли я купить» доступен. | The “can I buy this” answer is available. | нет |
| 283 | `i18n/start.mjs` · `start.fc_verdict_off` | с | Ответ «могу ли я купить» пока не появится: {reasons}. | The “can I buy this” answer does not appear yet: {reasons}. | нет |
| 284 | `i18n/start.mjs` · `start.go_buy` | с | Могу ли я купить? | Can I buy this? | нет |
| 285 | `i18n/start.mjs` · `start.tpl_review_pending` | с | Юридическое ревью формулировок и вычитка RU/EN ещё не выполнены: ждут людей. | Legal review of the wording and proofreading of RU/EN are not done yet: they wait for people. | нет |
| 286 | `i18n/start.mjs` · `start.card_partial` | с | Готовность данных {score} из 4: до ответа «могу ли я купить» не хватает части данных. | Data readiness {score} of 4: part of the data is still missing for the “can I buy this” answer. | нет |
| 287 | `i18n/start.mjs` · `start.mx_in_2` | с т | Есть: отметки «первый прогноз» и «вердикт доступен», ошибка минимума в базисных пунктах, покрытие «k из n». | It has: the “first forecast” and “verdict available” marks, the minimum error in basis points, the coverage “k of n”. | нет |
| 288 | `i18n/start.mjs` · `start.mx_row_verdict` | с | Вердикт доступен | Verdict available | нет |
| 289 | `i18n/start.mjs` · `start.mx_row_error` | т | Ошибка минимума | Minimum error | нет |
| 290 | `i18n/v0.mjs` · `v0.doc_title` | с | Runway v0 — могу ли я купить | Runway v0 — can I buy this | нет |
| 291 | `i18n/v0.mjs` · `v0.title` | с | Могу ли я это купить? | Can I buy this? | нет |
| 292 | `i18n/v0.mjs` · `v0.lead` | с | Калькулятор v0: остаток, до {pay} повторяющихся платежей, до {inc} поступлений и покупка. Считает тем же движком, что и основное приложение: расчёт по введённым данным и правилам, не консультация. Аккаунта нет; в браузере ничего не сохраняется и в сеть ничего не уходит: состояние — файл, который вы скачиваете сами. | Calculator v0: a balance, up to {pay} recurring payments, up to {inc} receipts and a purchase. It uses the same engine as the main app: calculated from the data and rules you enter; not advice. There is no account; nothing is kept in the browser and nothing goes to the network: the state is a file that you download yourself. | да |
| 293 | `i18n/v0.mjs` · `v0.disclaimer` | н с | Расчёт по введённым данным и правилам, не консультация. Налоги — только правила, которые вводите вы. Состояние хранится в файле, который вы скачиваете сами. | Calculated from the data and rules you enter; not advice. Taxes: only the rules you enter yourself. The state is kept in a file that you download yourself. | да |
| 294 | `i18n/v0.mjs` · `v0.f_from_reserve` | н | Платится из налогового конверта | Paid from the tax envelope | нет |
| 295 | `i18n/v0.mjs` · `v0.res_lead` | н с | Резервы — по желанию. Без них ответ подписывается «без учёта резервов». Ставку налогового конверта вводите вы: это ваше правило, а не совет. | Reserves are optional. Without them the answer is marked “without reserves”. You enter the rate of the tax envelope: it is your rule, not advice. | да |
| 296 | `i18n/v0.mjs` · `v0.res_tax` | н | налоговый конверт | tax envelope | нет |
| 297 | `i18n/v0.mjs` · `v0.h_res_name` | н | Например: налоговый конверт, страховка. | For example: tax envelope, insurance. | нет |
| 298 | `i18n/v0.mjs` · `v0.h_rate` | н | Только для налогового конверта: сколько процентов каждого поступления откладывать. Ставки по умолчанию нет. | Only for the tax envelope: what percent of each receipt to set aside. There is no default rate. | нет |
| 299 | `i18n/v0.mjs` · `v0.line_tax` | н с | Налоговый конверт «{name}»: отложено {funded}, ставка {rate} % (правило пользователя, не консультация) | Tax envelope “{name}”: set aside {funded}, rate {rate} % (user rule; not advice) | да |
| 300 | `i18n/v0.mjs` · `v0.r_gate` | с | Данных мало для вердикта: {reason}. | Not enough data for a verdict: {reason}. | нет |
| 301 | `i18n/v0.mjs` · `v0.gate_generic` | т | данных недостаточно | not enough data | нет |
| 302 | `i18n/v0.mjs` · `v0.r_verdict` | с | Вердикт | Verdict | нет |
| 303 | `i18n/v0.mjs` · `v0.r_no_reserves` | н | Без учёта резервов: есть поступление, но не заданы налоговый конверт и накопления. Числа посчитаны по физическим деньгам. | Without reserves: there is a receipt, but no tax envelope or savings are set. The numbers are calculated on physical money. | нет |
| 304 | `i18n/v0.mjs` · `v0.r_engine` | с | Расчёт {ref} · тот же движок, что в основном приложении · расчёт по введённым данным и правилам, не консультация. | Calculation {ref} · the same engine as the main app · calculated from the data and rules you enter; not advice. | да |
| 305 | `engine/verifier.mjs` · `PROJ.OK` | с | В режиме «{@mode}» к {to}: минимум денег на счетах — {min.amount_minor} ({min.date}), на конец периода — {end_close}.[[ Первая дата ниже нуля — {first_breach}.]][[ Деньги на счетах уходят ниже нуля через {runway_with_days}.]][[ Можно потратить до {to}: {sts_minor} при буфере {buffer_minor}.]][[ До буфера не хватает (с учётом резервов): {short_to_buffer_minor}.]][[ {@gate}]] | In the “{@mode}” mode up to {to}: the minimum money on the accounts is {min.amount_minor} ({min.date}), at the end of the period {end_close}.[[ The first date below zero is {first_breach}.]][[ Money on the accounts goes below zero in {runway_with_days}.]][[ Spendable up to {to}: {sts_minor} at a buffer of {buffer_minor}.]][[ Short of the buffer (after reserves): {short_to_buffer_minor}.]][[ {@gate}]] | нет |
| 306 | `engine/verifier.mjs` · `TAX.OK` | н с | Налоговый конверт на {as_of}: накоплено {reserved}.[[ Ближайший платёж — {next_due.date}: {next_due.payment_minor}.]] Расчёт по введённым правилам, не консультация. | Tax envelope on {as_of}: accumulated {reserved}.[[ The next payment is {next_due.date}: {next_due.payment_minor}.]] Calculated from the rules you entered; not advice. | да |
| 307 | `engine/verifier.mjs` · `GATE.rule_disabled` | н | Свободный остаток не показан: налоговое правило не подтверждено. | Free money is not shown: the tax rule is not confirmed. | нет |
| 308 | `engine/verifier.mjs` · `CAV.LIQUIDITY` | с т | Это расчёт ликвидности по вашим правилам и данным, не рекомендация. | This is a liquidity calculation by your rules and data, not a recommendation. | да |
| 309 | `engine/verifier.mjs` · `CAV.NOT_ADVICE` | с | Расчёт по введённым данным и правилам, не консультация. | Calculated from the data and rules you entered; not advice. | да |
| 310 | `engine/verifier.mjs` · `INSUFFICIENT.readiness` | с | Данных мало для вердикта: готовность данных ниже порога. Проверьте, что введены счёт, обязательные платежи, ближайшие поступления и повседневные траты. | Not enough data for an assessment: data readiness is below the threshold. Check that an account, obligatory payments, upcoming income and everyday spending are entered. | нет |
| 311 | `engine/verifier.mjs` · `INSUFFICIENT.stale` | с | Данных мало для вердикта: остаток давно не сверялся. Сверьте остаток счёта и введите актуальное значение. | Not enough data for an assessment: the balance has not been reconciled for a long time. Reconcile the account balance and enter the current value. | нет |
| 312 | `engine/verifier.mjs` · `INSUFFICIENT.no_anchor` | с | Данных мало для вердикта: нет подтверждённого остатка счёта. Введите остаток. | Not enough data for an assessment: there is no confirmed account balance. Enter the balance. | нет |
| 313 | `engine/verifier.mjs` · `INSUFFICIENT.no_buffer` | с | Данных мало для вердикта: не задан буфер. Введите буфер. | Not enough data for an assessment: the buffer is not set. Enter the buffer. | нет |
| 314 | `engine/verifier.mjs` · `INSUFFICIENT.rule_disabled` | н с | Данных мало для вердикта: налоговое правило не подтверждено. Проверьте правило. | Not enough data for an assessment: the tax rule is not confirmed. Check the rule. | нет |
| 315 | `engine/verifier.mjs` · `INSUFFICIENT.generic` | с | Данных мало для вердикта. Проверьте введённые данные. | Not enough data for an assessment. Check the entered data. | нет |
| 316 | `start_template.mjs` · `freelancer-skeleton.note` | н с | Скелет подсказывает названия строк. Сумм, ставок, налоговых календарей и шаблонов стран в нём нет: всё вводите вы. Расчёт по введённым данным и правилам, не консультация. | The skeleton only suggests row names. It has no amounts, rates, tax calendars or country templates: you enter everything. Calculated from the data and rules you enter; not advice. | да |
| 317 | `start_template.mjs` · `freelancer-skeleton.tax_rule.note` | н | Ставку и срок проверки правила вводите вы в разделе «Формы данных»; здесь их нет. | You enter the rate and the review term in the data forms; they are not here. | нет |

## 4. Реестр обещаний («обещаем / не обещаем»)

Все строки реестра `demo/promises.json` с текстами из каталога `showcase`. Уровень «гипотеза» в интерфейс не попадает (линтер блокирует сборку); измерение старше 90 дней блокирует сборку.

| № | Идентификатор | Вид | Уровень | n · дата измерения | RU | EN | Тест или измерение |
|---:|---|---|---|---|---|---|---|
| 1 | `golden` | обещаем | проверено тестом | — | Пример G-001 воспроизводится: восемь значений канона совпадают с расчётом движка. | The G-001 example is reproduced: eight canon values match the engine calculation. | `tests/g001.test.mjs · TST-01` |
| 2 | `minor_units` | обещаем | проверено тестом | — | Деньги хранятся и считаются целыми числами в минимальных единицах валюты; дробных денег нет. | Money is stored and calculated as whole numbers in minimal currency units; there is no fractional money. | `tests/money.test.mjs · TST-18` |
| 3 | `deterministic` | обещаем | проверено тестом | — | Одни и те же данные дают одни и те же числа и один и тот же хэш входных данных. | The same data gives the same numbers and the same input data hash. | `tests/analyze.test.mjs · TST-33` |
| 4 | `gate` | обещаем | проверено тестом | — | Вердикт и «можно потратить» отвечают только при достаточных данных; иначе показано «данных мало». | The verdict and "can spend" answer only when the data is sufficient; otherwise "not enough data" is shown. | `tests/afford.test.mjs · TST-04` |
| 5 | `a0_numbers` | обещаем | проверено тестом | — | В ответах помощника без языковой модели каждое число берётся из расчёта и проходит проверку верификатором. | In answers of the assistant without a language model every number comes from the calculation and passes the verifier. | `tests/verifier.test.mjs · TST-45` |
| 6 | `debt_zero` | обещаем | проверено тестом | — | График долга закрывается ровно в ноль: последний платёж поглощает остаток округлений. | A debt schedule closes at exactly zero: the last payment absorbs the rounding remainder. | `tests/debt.test.mjs · TST-29` |
| 7 | `journal_append` | обещаем | проверено тестом | — | Журнал записей только дополняется; снимок не меняет результат свёртки. | The journal is only appended to; a snapshot does not change the result of the fold. | `tests/journal_log.test.mjs · TST-16` |
| 8 | `no_network` | обещаем | проверено тестом | — | Страница читает с сервера только набор данных и не выполняет встроенный код; расчёт идёт в самой странице. | The page reads only the dataset from the server and runs no inline code; the calculation runs in the page itself. | `tests/demo.test.mjs · TST-59` |
| 9 | `untrusted` | обещаем | проверено тестом | — | Текст заметок и меток не попадает в результаты инструментов и в контекст модели; показывается только по кнопке. | The text of notes and tags does not reach tool results or the model context; it is shown only on a button press. | `tests/injection.test.mjs · TST-46` |
| 10 | `journal_speed` | обещаем | измерено | n = 3, 2026-10-05 | Журнал из 36 536 записей со снимком открывается за 2 секунды или быстрее (замер на машине разработки). | A journal of 36,536 records with a snapshot opens in 2 seconds or less (measured on a development machine). | `tests/journal_log.test.mjs · REQ-153` |
| 11 | `wizard_reasons` | обещаем | проверено тестом | — | Мастер «Старт» показывает прогноз при готовности данных 3 из 4 и называет, чего не хватает, по расчёту движка. | The Start wizard shows the forecast at data readiness 3 of 4 and names what is missing, from the engine calculation. | `tests/wizard.test.mjs · REQ-110` |
| 12 | `v0_same_engine` | обещаем | проверено тестом | — | Страница-калькулятор v0 считает тем же движком: на данных, эквивалентных G-001, вердикт и числа те же. | The v0 calculator page uses the same engine: on data equivalent to G-001 the verdict and the numbers are the same. | `tests/v0.test.mjs · REQ-180` |
| 13 | `local_metrics` | обещаем | проверено тестом | — | Метрики считаются только на устройстве; файл без сумм и дат показывается целиком до скачивания, приложение само его не отправляет. | Metrics are counted only on the device; the file without amounts or dates is shown in full before download and the app never sends it itself. | `tests/metrics.test.mjs · REQ-185` |
| 14 | `template_no_rates` | обещаем | проверено тестом | — | Шаблон-скелет не содержит сумм и ставок; налоговые правила вы вводите сами, расчёт по введённым правилам, не консультация. | The skeleton template has no amounts or rates; tax rules are entered by you, calculated from the rules you entered; not advice. | `tests/wizard.test.mjs · REQ-068` |
| 15 | `prob_off_by_default` | обещаем | проверено тестом | — | Вероятностная полоса и «при уверенности α максимум X» выключены по умолчанию, включаются лишь по вашему явному согласию и не меняют вердикты и числа Q1/Q3. | The probability band and “at confidence α, at most X” are off by default, are turned on only with your explicit consent and do not change the verdicts or the Q1/Q3 numbers. | `tests/prob_band.test.mjs · TST-49` |
| 16 | `quality_synthetic` | обещаем | проверено тестом | — | Проверка качества показана на синтетических журналах и подписана «синтетика»: это не данные пользователей и не оценка для реальных людей. | The quality check is shown on synthetic journals and labelled “synthetic”: it is not users’ data and not an estimate for real people. | `tests/quality_report.test.mjs · TST-55` |
| 17 | `accuracy` | не обещаем | проверено тестом | — | Не обещаем точность прогноза: число — расчёт по введённым данным, оно меняется, если данные неполны. | We do not promise forecast accuracy: a number is a calculation from the data you entered and it changes when the data is incomplete. | `tests/demo.test.mjs · TST-56` |
| 18 | `advice` | не обещаем | проверено тестом | — | Не даём налоговых, юридических и инвестиционных советов: налоговые правила — ваши данные, расчёт по введённым правилам, не консультация. | We give no tax, legal or investment advice: tax rules are your data, calculated from the rules you entered; not advice. | `tests/demo.test.mjs · TST-56` |
| 19 | `bank_sync` | не обещаем | проверено тестом | — | Банковской синхронизации в первой версии нет: данные вводятся и загружаются из файлов. | There is no bank synchronisation in the first version: data is entered and loaded from files. | `tests/demo.test.mjs · TST-59` |
| 20 | `migration` | не обещаем | проверено тестом | — | Не обещаем, что при переносе данных не будет ошибок: после загрузки показывается отчёт — что распознано, отклонено и пропущено как повтор. | We do not promise that moving data has no errors: after loading, a report shows what was recognised, rejected and skipped as a repeat. | `tests/import_wizard.test.mjs · TST-42` |
| 21 | `first_minutes` | не обещаем | проверено тестом | — | Время до первого прогноза не заявляем: измерения на других людях нет. | We do not state the time to the first forecast: there is no measurement on other people. | `tests/demo.test.mjs · TST-56` |
| 22 | `buy_advice` | не обещаем | проверено тестом | — | Вердикт — оценка по вашим данным, а не рекомендация покупать или не покупать. | The verdict is an estimate from your data, not a recommendation to buy or not to buy. | `tests/afford.test.mjs · TST-04` |
| 23 | `human_review_pending` | не обещаем | проверено тестом | — | Юридическое ревью формулировок и вычитка RU/EN не выполнены: они ждут людей, готовности мы не заявляем. | Legal review of the wording and proofreading of RU/EN are not done: they wait for people, and we do not claim readiness. | `tests/wizard.test.mjs · REQ-183` |
| 24 | `prob_not_promise` | не обещаем | проверено тестом | — | Вероятностные оценки — эксперимент, а не обещание: при малом числе наблюдений вместо процента будет счёт «в k из n», без истории — отказ. | Probability estimates are an experiment, not a promise: with few observations you get a count “in k of n” instead of a percentage, and with no history a refusal. | `tests/prob_band.test.mjs · TST-49` |

## 5. Канонические формулировки словаря

Из `prototype/engine/vocab.json`: на них опираются шаблоны ответов и проверки.

### 5.1. Оговорка про налоги

| Язык | Текст |
|---|---|
| RU | расчёт по введённым правилам, не консультация |
| EN | calculated from the rules you entered; not advice |

### 5.2. Подписи вердиктов

| Код | RU | EN |
|---|---|---|
| `OK` | выдерживает | holds |
| `FRAGILE` | хрупко | fragile |
| `TIGHT` | впритык | tight |
| `NO` | не хватает | short |

### 5.3. Запрещённые формулировки

Этот список линтер `node tools/lint_vocab.mjs` ловит в интерфейсе и в вики; перечислен ниже как запрещённый, а не как образец. Если ревью добавит слова к запрету, список пополняют в `vocab.json` (решение владельца).

| № | Запрещено |
|---:|---|
| 1 | без галлюцинаций |
| 2 | точные цифры |
| 3 | гарантируем |
| 4 | гарантир |
| 5 | да, спокойно |
| 6 | безопасно |
| 7 | прогноз точен |
| 8 | не уйдёте в минус |
| 9 | ваши финансы только у вас |
| 10 | только ваши |
| 11 | мы посчитаем налоги |
| 12 | защитит от штрафов |
| 13 | даже мы не можем прочитать |
| 14 | полностью работает без сети |
| 15 | всегда офлайн |
| 16 | ранняя безопасная дата |
| 17 | данные не пропадут |
| 18 | ии-советник |
| 19 | рекомендуем купить |
| 20 | рекомендуем сократить |

## 6. Шаблон записи ревью

Заполняет человек (ревьюер или владелец по его замечаниям). Копию сохранить рядом как `_ops/people/legal-review-record-ГГГГ-ММ-ДД.md`; этот файл не править. Публичная бета без заполненной записи не открывается (REQ-183). Запись создаёт человек, а не агент: проверку формулировок агенты не заменяют.

```text
ЗАПИСЬ ЮРИДИЧЕСКОГО РЕВЬЮ ФОРМУЛИРОВОК (REQ-183)

Кто проверял (имя или организация, роль):
Юрисдикция и право, для которых даны выводы:
Дата начала ревью:                       Дата завершения:
Отпечаток выгрузки пакета (из шапки):    c32a7633796a0443
Объём: § 3 строки интерфейса (все / выборочно: …), § 4 реестр, § 5 словарь

РЕШЕНИЕ ПО НАЛОГОВОЙ ЧАСТИ (отметить одно):
[ ] оставить как есть
[ ] оставить с изменениями из таблицы замечаний
[ ] признаётся консультацией: налоговая часть удаляется (REQ-064…068, ALG-06)

ЗАМЕЧАНИЯ
№ замечания | № строки пакета и ключ | Цитата | Замечание | Серьёзность | Предложенная формулировка | Принятая правка (кто, когда) | Статус
            |                        |         |           | блокирует бету / исправить до беты / пожелание |  |  | открыто / внесено / отклонено (причина)

ОТВЕТЫ НА ВОПРОСЫ ПАКЕТА
Q1:      Q2:      Q3:      Q4:      Q5:      Q6:      Q7:      Q8:

ПРАВКИ ВНЕСЕНЫ В КОД
Дата, кто внёс, какие ключи изменены:
После правок выполнено: node tools/lint_vocab.mjs (0 ошибок), node tools/people_pack.mjs legal (пакет пересобран), тесты по файлам:

ЧТО ПОМЕНЯТЬ В ПРИЛОЖЕНИИ ПОСЛЕ РЕВЬЮ (решает владелец)
[ ] строка about.legal_3 (экран «О программе»)
[ ] утверждение human_review_pending в реестре обещаний и его тексты showcase.cl_human_review_pending
[ ] строка start.tpl_review_pending

Подпись и дата:
```

## Связанные страницы

- [Требования, REQ-183](../../wiki/product/02-requirements.md)
- [Риски RISK-06 и RISK-11](../../wiki/product/12-risks.md)
- [Дорожная карта: критерий остановки № 5](../../wiki/product/10-roadmap.md)
- [Остальные пакеты для людей](README.md)
