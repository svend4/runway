// people_pack.mjs — сборка пакета для людей из кода (FP-27, REQ-183): выгрузка строк про налоги, «советы» и точность для юридического ревью.
// Зачем. Пакет для юриста обязан совпадать с тем, что видит человек в приложении. Руками такую выгрузку не поддержать: строки интерфейса меняются каждую волну.
// Поэтому файл `_ops/people/legal-review-package.md` собирается этим скриптом из тех же источников, что и сам интерфейс:
//   - каталоги строк `demo/i18n.mjs` и `demo/i18n/*.mjs` (RU и EN), шаблоны ответов `engine/verifier.mjs`, шаблон-скелет мастера «Старт» `demo/start_template.mjs`
//     (список каталогов берётся у линтера слов `tools/lint_vocab.mjs`: `load_catalogs` и `load_template_catalogs` — один источник правды);
//   - реестр обещаний `demo/promises.json` вместе с текстами утверждений из каталога `showcase`;
//   - словарь `engine/vocab.json`: оговорка про налоги, подписи вердиктов, список запрещённых формулировок.
// Выборка строк — по ключевым словам с запасом (`CLASSES`): лишнее юрист пропустит, а пропущенное по ошибке выборки было бы хуже. Строка попадает в таблицу,
// если ключевое слово есть в её RU- или EN-тексте ИЛИ (класс «налоги») её ключ относится к налоговому конверту и экрану резервов (`tax_key`): налоговая часть интерфейса говорит
// «правило / конверт / ставка» и слова «налог» может не содержать (выборка только по тексту пропускала rs.tax_line, forms.tax_none и ещё десятки строк: дефект проверки FP-27).
// Классы: «налоги», «советы» (в том числе вердикт и «можно потратить»: граница «информация против совета», RISK-11), «точность».
// В файле нет даты, часов и путей этой машины: сборка детерминирована, поэтому `--check` может сравнить файл с кодом побайтно. Фильтры не заменяют чтение интерфейса.
// Чистые функции (`classify`, `collect_rows`, `build_legal_package`) не читают файлы и не пишут; чтение каталогов и запись файла — только `collect_legal_data` и `main`.
// Сеть не используется. Расчёт по введённым данным и правилам, не консультация; сам пакет — не юридическая консультация, он лишь собирает тексты для специалиста.
//
// Использование (из каталога prototype/):
//   node tools/people_pack.mjs legal            — пересобрать ../_ops/people/legal-review-package.md
//   node tools/people_pack.mjs legal --check    — не писать; код выхода 1, если файл не совпадает с кодом (пакет устарел)
//   node tools/people_pack.mjs legal --out <файл> — записать в другой файл

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
export const RUNWAY_ROOT = path.join(PROTO, '..');

/** Файл пакета для юриста. */
export const LEGAL_FILE = path.join(RUNWAY_ROOT, '_ops', 'people', 'legal-review-package.md');

const NOT_LETTER = '(?<![\\p{L}\\d])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\d])';

/** Экраны, целиком относимые к налоговому конверту: `rs` — «Резервы», `reserveui` — карточки резервов и разбор «Как посчитано». */
const TAX_SCREENS = new Set(['rs', 'reserveui']);

/**
 * Ключ строки относится к налоговому конверту или экрану резервов: любой из его кусков (по `.` и `_`) начинается с `tax` или `envelope`
 * (`rs.tax_line`, `forms.h_tax_rate`, `forms.f_rate_tax`, `freelancer-skeleton.tax_rule.note`) либо ключ принадлежит экрану «Резервы» (`rs.*`)
 * или карточкам резервов с разбором «Как посчитано» (`reserveui.*`): там показаны суммы «в конверт по правилу пользователя» (вопрос Q1 пакета).
 * @param {string} key
 * @returns {boolean}
 */
export function tax_key(key) {
  const parts = String(key ?? '').split(/[._]/);
  return TAX_SCREENS.has(parts[0]) || parts.some((p) => /^(?:tax|envelope)/i.test(p));
}

/**
 * Классы выборки. Ключевые слова проверяются по RU- и EN-тексту строки; слова даны с запасом (основы, а не формы).
 * `tax` — всё, где названы налоги или налоговый конверт (слова «конверт» и envelope; плюс строки по ключу — `tax_key`); `advice` — слова «совет / консультация / рекомендация», вердикт и «можно потратить» (то, что человек может прочесть как указание);
 * `accuracy` — точность, обещания, уверенность и вероятность, оговорки «эксперимент, не обещание», честные «не заявляем».
 */
export const CLASSES = Object.freeze([
  Object.freeze({
    id: 'tax',
    label: 'налоги',
    key_test: tax_key,
    re: new RegExp('налог|конверт|envelope|' + NOT_LETTER + 'tax|' + NOT_LETTER + 'vat' + NOT_LETTER_AFTER + '|' + NOT_LETTER + 'ндс' + NOT_LETTER_AFTER + '|' + NOT_LETTER + 'iva' + NOT_LETTER_AFTER + '|вычет|deduct|декларац', 'iu'),
  }),
  Object.freeze({
    id: 'advice',
    label: 'советы',
    re: /совет|консульт|рекоменд|advice|advis|recommend|consult|инвестиц|invest|юрид|юрист|legal|lawyer|ответственност|liabil|можно потратить|can spend|safe[- ]to[- ]spend|вердикт|verdict|могу ли я купить|можно ли купить|can i (?:afford|buy)/iu,
  }),
  Object.freeze({
    id: 'accuracy',
    label: 'точность',
    re: /точност|точн(?:ый|ая|ое|ые|о)(?![\p{L}\d])|accura|precis|гарант|guarant|погрешн|обещ|promis|заявля|(?:do not|don't) (?:state|claim)|уверенност|confidence|вероятност|probab|эксперимент|experiment|не рекомендаци|not a recommendation|гипотез[аы]-бюджет|качеств[оа] прогноз|forecast quality|ошибк[аиу] минимум/iu,
  }),
]);

/** Признак «оговорка в самой строке»: «не консультация», «не рекомендация» / «not advice», «not a recommendation». */
const DISCLAIMER_RE = /не консультация|не рекомендация|не является (?:налоговой |юридической )?консультаци|not advice|not a recommendation|not tax advice|not legal advice/iu;

/**
 * Классы, к которым относится строка.
 * @param {string} ru
 * @param {string} en
 * @param {string} [key] ключ строки в каталоге: класс может подтвердить и ключ (`key_test` класса), а не только слова текста
 * @returns {string[]} идентификаторы классов в порядке `CLASSES`
 */
export function classify(ru, en, key = undefined) {
  const text = String(ru ?? '') + '\n' + String(en ?? '');
  return CLASSES.filter((c) => c.re.test(text) || (key !== undefined && c.key_test !== undefined && c.key_test(key))).map((c) => c.id);
}

/** Есть ли в строке оговорка «не консультация / not advice». */
export function has_disclaimer(ru, en) {
  return DISCLAIMER_RE.test(String(ru ?? '')) || DISCLAIMER_RE.test(String(en ?? ''));
}

/**
 * Строки выборки: по каталогам в их порядке и по ключам в порядке файла.
 * @param {{file: string, ru: Object<string,string>, en: Object<string,string>}[]} catalogs
 * @returns {{no: number, file: string, key: string, ru: string, en: string, classes: string[], disclaimer: boolean}[]}
 */
export function collect_rows(catalogs) {
  const rows = [];
  for (const cat of catalogs) {
    for (const key of Object.keys(cat.ru)) {
      const ru = cat.ru[key];
      const en = cat.en?.[key] ?? '';
      if (typeof ru !== 'string') continue;
      const classes = classify(ru, en, key);
      if (classes.length === 0) continue;
      rows.push({ no: rows.length + 1, file: cat.file.replace(/^prototype\//, ''), key, ru, en, classes, disclaimer: has_disclaimer(ru, en) });
    }
  }
  return rows;
}

/** Число строк во всех каталогах (для шапки: «выбрано N из M»). */
export function count_strings(catalogs) {
  return catalogs.reduce((a, c) => a + Object.keys(c.ru).length, 0);
}

/** Ячейка таблицы markdown: без переводов строк и вертикальных черт. */
export function cell(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');
}

const class_label = (id) => CLASSES.find((c) => c.id === id)?.label ?? id;

/** Строки реестра обещаний с текстами RU и EN (ключ `text_key` ищется во всех каталогах). */
export function registry_rows(registry, catalogs) {
  const find = (lang, key) => {
    for (const c of catalogs) if (typeof c[lang]?.[key] === 'string') return c[lang][key];
    return '';
  };
  return registry.map((r, i) => ({
    no: i + 1,
    id: r.id,
    kind: r.kind,
    level: r.level,
    n: r.n ?? null,
    measured_on: r.measured_on ?? null,
    checked_on: r.checked_on,
    test: r.test?.file + ' · ' + r.test?.id,
    ru: find('ru', r.text_key),
    en: find('en', r.text_key),
  }));
}

const KIND_RU = Object.freeze({ promise: 'обещаем', non_promise: 'не обещаем' });
const LEVEL_RU = Object.freeze({ verified: 'проверено тестом', measured: 'измерено', hypothesis: 'гипотеза' });

/** Отпечаток содержимого: sha256 от таблиц и канонических формулировок, первые 16 знаков. */
export function fingerprint(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * Текст пакета для юридического ревью.
 * @param {{engine_version: string, catalogs: {file: string, ru: Object<string,string>, en: Object<string,string>}[], vocab: object, registry: object[]}} data
 * @returns {string} markdown, переводы строк LF, заканчивается одним переводом строки
 */
export function build_legal_package(data) {
  const rows = collect_rows(data.catalogs);
  const total = count_strings(data.catalogs);
  const reg = registry_rows(data.registry, data.catalogs);
  const verdicts = Object.entries(data.vocab.verdicts ?? {});
  const forbidden = data.vocab.forbidden_phrases ?? [];
  const per_class = Object.fromEntries(CLASSES.map((c) => [c.id, rows.filter((r) => r.classes.includes(c.id)).length]));
  const tax_no_disclaimer = rows.filter((r) => r.classes.includes('tax') && !r.disclaimer).length;
  const fp = fingerprint({
    rows: rows.map((r) => [r.file, r.key, r.ru, r.en]),
    registry: reg,
    tax: data.vocab.tax_disclaimer,
    verdicts,
    forbidden,
  });

  const out = [];
  const push = (...lines) => out.push(...lines);

  push(
    '# Пакет для юридического ревью формулировок (REQ-183)',
    '',
    '> Файл собран скриптом `prototype/tools/people_pack.mjs` из кода приложения; **руками не править** (таблицы пересоберутся). Это не юридическая консультация и не заменяет её:',
    '> пакет только собирает тексты про налоги, «советы» и точность, чтобы их прочитал специалист. Расчёт по введённым данным и правилам, не консультация.',
    '',
    '| Что | Значение |',
    '|---|---|',
    '| Отпечаток выгрузки (sha256, 16 знаков) | `' + fp + '` |',
    '| Версия движка | `' + data.engine_version + '` |',
    '| Каталогов строк · строк всего | ' + data.catalogs.length + ' · ' + total + ' |',
    '| Строк в выборке (§3) | ' + rows.length + ' (налоги — ' + per_class.tax + ', советы — ' + per_class.advice + ', точность — ' + per_class.accuracy + '; строка может относиться к нескольким классам) |',
    '| Из них про налоги без оговорки в самой строке | ' + tax_no_disclaimer + ' (оговорка может стоять рядом на экране: проверяется по интерфейсу, а не по строке) |',
    '| Утверждений в реестре обещаний (§4) | ' + reg.length + ' |',
    '| Дата выгрузки, ревьюер, решение | записываются в отдельной записи ревью по шаблону §6, не здесь |',
    '',
    '## 1. Зачем этот пакет и что нужно от ревьюера',
    '',
    'Runway — приложение для прогноза денежного потока: оно считает по данным и правилам, которые ввёл сам человек, и показывает минимум свободных денег, ответ на вопрос «могу ли я купить» и запас под налоги. В интерфейсе три группы текстов, которые требуют взгляда юриста (RISK-06, RISK-11, [REQ-183](../../wiki/product/02-requirements.md)):',
    '',
    '1. **Налоги.** Ставок и шаблонов стран в приложении нет; налоговые правила — данные пользователя, а приложение откладывает «в конверт» долю, которую задал он сам. Нужна оценка, не станет ли такой показ налоговой консультацией, и достаточны ли оговорки.',
    '2. **«Советы».** Вердикт («выдерживает / впритык / хрупко / не хватает») и «можно потратить» — это расчёт ликвидности по правилам пользователя, а не рекомендация покупать или не покупать. Нужна оценка, как это прочтёт человек, и не пересекает ли формулировка границу «информация против совета».',
    '3. **Точность.** Приложение не обещает точность прогноза; есть реестр утверждений с уровнем доказанности («проверено тестом», «измерено», «гипотеза» в интерфейс не попадает). Нужна оценка, не создаёт ли какая-то формулировка обещания, которого продукт не даёт.',
    '',
    '**О чём просим.** Прочитать таблицы §3–§5. По каждой строке отметить «принять», «заменить текстом …» или «удалить». Ответить на вопросы Q1–Q8 ниже. Решить судьбу налоговой части: оставить, оставить с изменениями или удалить (если ревью признаёт налоговую часть консультацией, она удаляется: правила REQ-064…068, ALG-06; остаются накопление на страховку и ручной резерв, строка № 5 раздела «Критерии остановки и пивота» дорожной карты). Назвать юрисдикции, для которых вывод верен.',
    '',
    '**О чём не просим.** Не просим проверять арифметику прогноза и не просим консультации по налогам для конкретного человека.',
    '',
    '**Вопросы ревьюеру.**',
    '',
    '| № | Вопрос |',
    '|---|---|',
    '| Q1 | Считается ли показ суммы «в конверт по правилу пользователя» налоговой консультацией, если ставку вводит сам пользователь, а приложение ставок не содержит? |',
    '| Q2 | Достаточна ли оговорка «расчёт по введённым данным и правилам, не консультация» (§5.1) и на каких поверхностях она обязательна (обзор, покупка, резервы, ответы ассистента, печать)? |',
    '| Q3 | Читается ли вердикт («выдерживает / впритык / хрупко / не хватает») и «можно потратить» как рекомендация? Допустимы ли заголовки вида «Могу ли я это купить?»? |',
    '| Q4 | Достаточно ли «не обещаем точность прогноза» и отметки «эксперимент, не обещание» у вероятностных оценок? Нужна ли оговорка о том, что прошлые платежи не предсказывают будущие? |',
    '| Q5 | Нет ли совета в шаблонах ответов ассистента A0 (строки из `engine/verifier.mjs`)? |',
    '| Q6 | Какими словами можно сказать после ревью, что оно проведено (сейчас в интерфейсе: «Юридическое ревью формулировок … не выполнены»)? |',
    '| Q7 | Нужны ли для версии без аккаунтов и без сервера отдельные условия использования и сведения об ответственности (в приложении их нет)? |',
    '| Q8 | Есть ли формулировки, которые для вашей юрисдикции нельзя употреблять даже с оговоркой? |',
    '',
    '## 2. Как устроен пакет',
    '',
    '- Источник — код, а не копия вручную: каталоги строк `prototype/demo/i18n.mjs` и `prototype/demo/i18n/*.mjs`, шаблоны ответов `prototype/engine/verifier.mjs`, шаблон-скелет мастера «Старт» `prototype/demo/start_template.mjs`, реестр обещаний `prototype/demo/promises.json`, словарь `prototype/engine/vocab.json`.',
    '- Выборка по ключевым словам с запасом (RU или EN): налоги — «налог», «конверт», tax, envelope, VAT, НДС, IVA, «вычет», declaration; советы — «совет», «консульт», «рекоменд», advice, recommend, «инвестиц», «юрид», «вердикт», «можно потратить», «могу ли я купить»; точность — «точност», accuracy, «гарант», «обещ», promise, «уверенност», «вероятност», «эксперимент». Строка с любым словом попадает в таблицу целиком. Налоговый конверт и правила не всегда называют налог словом, поэтому к налогам отнесены ещё строки по ключу: куски ключа, начинающиеся с `tax` или `envelope` (например `rs.tax_line`, `forms.tax_none`, `forms.h_tax_rate`, `forms.f_rate_tax`), и все ключи экранов `rs.*` («Резервы») и `reserveui.*` (карточки резервов и разбор «Как посчитано»). Если на экране есть строка про налоги, советы или точность, которой нет в таблице, это дефект выборки: сообщить, пакет будет пересобран.',
    '- Номер строки `№` — для ссылок в записи ревью. Номера меняются при пересборке: в записи ревью указывать и номер, и ключ, и отпечаток выгрузки.',
    '- Пересборка: `node tools/people_pack.mjs legal` из `prototype/`; проверка, что пакет не устарел: `node tools/people_pack.mjs legal --check` (код выхода 1, если файл расходится с кодом). Тест `tests/people_pack.test.mjs` делает ту же проверку.',
    '- В пакет не входят тексты вне перечисленных источников (вики, README, страницы вне приложения): их читают по ссылкам из записи ревью.',
    '',
    '## 3. Строки интерфейса: налоги, «советы», точность',
    '',
    'Колонка «Оговорка» — есть ли в самой строке «не консультация» или «not advice». «Классы»: н — налоги, с — советы, т — точность.',
    '',
    '| № | Файл · ключ | Классы | RU | EN | Оговорка |',
    '|---:|---|:-:|---|---|:-:|',
  );
  const short = { tax: 'н', advice: 'с', accuracy: 'т' };
  for (const r of rows) {
    push('| ' + r.no + ' | `' + r.file.replace(/^demo\//, '') + '` · `' + r.key + '` | ' + r.classes.map((c) => short[c] ?? c).join(' ') + ' | ' + cell(r.ru) + ' | ' + cell(r.en) + ' | ' + (r.disclaimer ? 'да' : 'нет') + ' |');
  }

  push(
    '',
    '## 4. Реестр обещаний («обещаем / не обещаем»)',
    '',
    'Все строки реестра `demo/promises.json` с текстами из каталога `showcase`. Уровень «гипотеза» в интерфейс не попадает (линтер блокирует сборку); измерение старше 90 дней блокирует сборку.',
    '',
    '| № | Идентификатор | Вид | Уровень | n · дата измерения | RU | EN | Тест или измерение |',
    '|---:|---|---|---|---|---|---|---|',
  );
  for (const r of reg) {
    const when = r.level === 'measured' ? 'n = ' + r.n + ', ' + r.measured_on : '—';
    push('| ' + r.no + ' | `' + r.id + '` | ' + (KIND_RU[r.kind] ?? r.kind) + ' | ' + (LEVEL_RU[r.level] ?? r.level) + ' | ' + when + ' | ' + cell(r.ru) + ' | ' + cell(r.en) + ' | `' + cell(r.test) + '` |');
  }

  push(
    '',
    '## 5. Канонические формулировки словаря',
    '',
    'Из `prototype/engine/vocab.json`: на них опираются шаблоны ответов и проверки.',
    '',
    '### 5.1. Оговорка про налоги',
    '',
    '| Язык | Текст |',
    '|---|---|',
    '| RU | ' + cell(data.vocab.tax_disclaimer?.ru) + ' |',
    '| EN | ' + cell(data.vocab.tax_disclaimer?.en) + ' |',
    '',
    '### 5.2. Подписи вердиктов',
    '',
    '| Код | RU | EN |',
    '|---|---|---|',
  );
  for (const [code, v] of verdicts) push('| `' + code + '` | ' + cell(v.ru) + ' | ' + cell(v.en) + ' |');
  push(
    '',
    '### 5.3. Запрещённые формулировки',
    '',
    'Этот список линтер `node tools/lint_vocab.mjs` ловит в интерфейсе и в вики; перечислен ниже как запрещённый, а не как образец. Если ревью добавит слова к запрету, список пополняют в `vocab.json` (решение владельца).',
    '',
    '| № | Запрещено |',
    '|---:|---|',
  );
  forbidden.forEach((p, i) => push('| ' + (i + 1) + ' | ' + cell(p) + ' |'));

  push(
    '',
    '## 6. Шаблон записи ревью',
    '',
    'Заполняет человек (ревьюер или владелец по его замечаниям). Копию сохранить рядом как `_ops/people/legal-review-record-ГГГГ-ММ-ДД.md`; этот файл не править. Публичная бета без заполненной записи не открывается (REQ-183). Запись создаёт человек, а не агент: проверку формулировок агенты не заменяют.',
    '',
    '```text',
    'ЗАПИСЬ ЮРИДИЧЕСКОГО РЕВЬЮ ФОРМУЛИРОВОК (REQ-183)',
    '',
    'Кто проверял (имя или организация, роль):',
    'Юрисдикция и право, для которых даны выводы:',
    'Дата начала ревью:                       Дата завершения:',
    'Отпечаток выгрузки пакета (из шапки):    ' + fp,
    'Объём: § 3 строки интерфейса (все / выборочно: …), § 4 реестр, § 5 словарь',
    '',
    'РЕШЕНИЕ ПО НАЛОГОВОЙ ЧАСТИ (отметить одно):',
    '[ ] оставить как есть',
    '[ ] оставить с изменениями из таблицы замечаний',
    '[ ] признаётся консультацией: налоговая часть удаляется (REQ-064…068, ALG-06)',
    '',
    'ЗАМЕЧАНИЯ',
    '№ замечания | № строки пакета и ключ | Цитата | Замечание | Серьёзность | Предложенная формулировка | Принятая правка (кто, когда) | Статус',
    '            |                        |         |           | блокирует бету / исправить до беты / пожелание |  |  | открыто / внесено / отклонено (причина)',
    '',
    'ОТВЕТЫ НА ВОПРОСЫ ПАКЕТА',
    'Q1:      Q2:      Q3:      Q4:      Q5:      Q6:      Q7:      Q8:',
    '',
    'ПРАВКИ ВНЕСЕНЫ В КОД',
    'Дата, кто внёс, какие ключи изменены:',
    'После правок выполнено: node tools/lint_vocab.mjs (0 ошибок), node tools/people_pack.mjs legal (пакет пересобран), тесты по файлам:',
    '',
    'ЧТО ПОМЕНЯТЬ В ПРИЛОЖЕНИИ ПОСЛЕ РЕВЬЮ (решает владелец)',
    '[ ] строка about.legal_3 (экран «О программе»)',
    '[ ] утверждение human_review_pending в реестре обещаний и его тексты showcase.cl_human_review_pending',
    '[ ] строка start.tpl_review_pending',
    '',
    'Подпись и дата:',
    '```',
    '',
    '## Связанные страницы',
    '',
    '- [Требования, REQ-183](../../wiki/product/02-requirements.md)',
    '- [Риски RISK-06 и RISK-11](../../wiki/product/12-risks.md)',
    '- [Дорожная карта: критерий остановки № 5](../../wiki/product/10-roadmap.md)',
    '- [Остальные пакеты для людей](README.md)',
  );
  return out.join('\n') + '\n';
}

/**
 * Прочитать источники пакета с диска.
 * @param {string} [root] корень runway/
 */
export async function collect_legal_data(root = RUNWAY_ROOT) {
  const imp = (...p) => import(pathToFileURL(path.join(root, ...p)).href);
  const lint = await imp('tools', 'lint_vocab.mjs');
  const catalogs = [...(await lint.load_catalogs(root)), ...(await lint.load_template_catalogs(root))];
  const engine = await imp('prototype', 'engine', 'index.mjs');
  const vocab = JSON.parse(fs.readFileSync(path.join(root, 'prototype', 'engine', 'vocab.json'), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'prototype', 'demo', 'promises.json'), 'utf8'));
  return { engine_version: engine.ENGINE_VERSION, catalogs, vocab, registry };
}

const HELP = `Использование: node tools/people_pack.mjs legal [--check] [--out <файл>]
  legal          пересобрать пакет для юридического ревью (по умолчанию ../_ops/people/legal-review-package.md)
  --check        ничего не писать; код выхода 1, если файл не совпадает с кодом (пакет устарел)
  --out <файл>   записать в другой файл`;

/** Командная строка; возвращает код выхода (0 — готово, 1 — пакет устарел или сбой, 2 — неверный запуск). */
export async function main(argv, io = { read: (p) => fs.readFileSync(p, 'utf8'), write: (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t, 'utf8'); }, exists: (p) => fs.existsSync(p), out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }) {
  const cmd = argv[0];
  if (cmd === '--help' || cmd === undefined) { (cmd === '--help' ? io.out : io.err)(HELP); return cmd === '--help' ? 0 : 2; }
  if (cmd !== 'legal') { io.err('Неизвестная команда «' + cmd + '».\n' + HELP); return 2; }
  const i_out = argv.indexOf('--out');
  if (i_out >= 0 && (argv[i_out + 1] === undefined || argv[i_out + 1].startsWith('--'))) { io.err('После --out нужен путь к файлу.'); return 2; }
  const file = i_out >= 0 ? path.resolve(argv[i_out + 1]) : LEGAL_FILE;
  let text;
  try {
    text = build_legal_package(await collect_legal_data());
  } catch (e) {
    io.err('Сборка не удалась: ' + (e?.code ?? e?.message ?? 'ошибка'));
    return 1;
  }
  if (argv.includes('--check')) {
    const have = io.exists(file) ? io.read(file).replace(/\r\n/g, '\n') : null;
    if (have === text) { io.out('Пакет совпадает с кодом: ' + file); return 0; }
    io.err('Пакет ' + (have === null ? 'не найден' : 'устарел') + ': ' + file + '. Пересобрать: node tools/people_pack.mjs legal');
    return 1;
  }
  io.write(file, text);
  io.out('Записано: ' + file + ' (' + text.split('\n').length + ' строк)');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
