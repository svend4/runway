#!/usr/bin/env node
// Линтер словаря и обещаний (TST-56, design-brief §10, §2.0, C-062, C-063, C-089). Использование:
//   node tools/lint_vocab.mjs                    — отчёт по wiki/**/*.md и prototype/demo, код выхода 1 при ошибках
//   node tools/lint_vocab.mjs --json             — машиночитаемый вывод
//   node tools/lint_vocab.mjs --dir <путь>       — дополнительно просканировать каталог (рекурсивно)
//   node tools/lint_vocab.mjs --registry <файл>  — реестр обещаний (JSON, по умолчанию prototype/demo/promises.json, если есть)
//   node tools/lint_vocab.mjs --today YYYY-MM-DD — «сегодня» для сроков годности измерений (по умолчанию — системная дата)
//   node tools/lint_vocab.mjs --ignore <файл>    — реестр исключений для предупреждений (по умолчанию tools/lint_vocab_ignore.json: файл, правило, число, причина)
//   node tools/lint_vocab.mjs --no-ignore        — не применять реестр исключений (показать все предупреждения как есть)
//   node tools/lint_vocab.mjs --show-ignored     — перечислить предупреждения, разобранные реестром, с причинами
//   node tools/lint_vocab.mjs --coverage         — НЕ линт, а перечень чисел G-001 в wiki/**/*.md без метки `num:` (REQ-177); по умолчанию не включён, код выхода 0
//                                                   (`--limit N` — сколько строк печатать, `--json` — машиночитаемый вывод)
//
// Что проверяется:
//   1. Запрещённые формулировки §10 (список — `forbidden_phrases` из prototype/engine/vocab.json + контекстные правила): «без галлюцинаций»,
//      «безопасно», «да, спокойно», «прогноз точен», «всегда офлайн», «ранняя безопасная дата», «первый прогноз за 10 минут» без измерения и т. д.
//   2. Недопустимые вердикты вне словаря §2.0 (OK, TIGHT, FRAGILE, NO / выдерживает, впритык, хрупко, не хватает): старые «спокойно», «нельзя», «безопасно»…
//   3. Метки чисел `<!--num:G-001.ключ=значение-->` сверяются с golden-выводом движка на prototype/data/g001.json: расхождение — ERROR.
//   4. Реестр обещаний: `level = hypothesis` в интерфейсе, `measured` старше 90 дней или без даты, «первый прогноз за N минут» без измерения — ERROR.
//   5. Императивы в каталогах строк интерфейса (prototype/demo/i18n.mjs, demo/i18n/*.mjs; REQ-046) и в шаблонах ответов (engine/verifier.mjs,
//      demo/start_template.mjs): допустимы только «проверьте», «введите», «сверьте» (EN: check, enter, reconcile, compare) — константа
//      ALLOWED_IMPERATIVES; остальное — ERROR, строка заменяется нейтральной формулировкой. EN: известные глаголы-команды, любой переходный глагол
//      в начале предложения («Adjust the buffer.») и отрицательные команды («Do not …», «Never …»).
// Игнорируются места, где формулировка приведена КАК запрещённая: таблицы с заголовком «Нельзя/Запрещено/Вместо», разделы с заголовком «Нельзя…»,
// строки с оговоркой запрета («запрещено», «нельзя», «вместо», «не использовать», …) и отрицания («не гарантируем»); в wiki/tools, wiki/sources,
// wiki/comparisons и raw — атрибутированные цитаты (в кавычках, со словами «заявлено», «лендинг», «Budget Guru», «(не подтверждено)», C-089);
// явное исключение — комментарий `<!-- lint-vocab: ignore -->` в этой или предыдущей строке.
// Без зависимостей, Node >= 18. Расчёт по введённым данным, не консультация.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VOCAB_PATH = join(ROOT, 'prototype', 'engine', 'vocab.json');

// ── словарь ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Загрузить vocab.json (словарь §2.0 и `forbidden_phrases`). */
export function load_vocab(path = VOCAB_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Допустимые значения вердикта: идентификаторы, подписи RU/EN и «пустышки» схем. */
export function allowed_verdict_words(vocab) {
  const set = new Set();
  for (const [k, v] of Object.entries(vocab.verdicts ?? {})) {
    set.add(k.toLowerCase());
    set.add(String(v.ru).toLowerCase());
    set.add(String(v.en).toLowerCase());
  }
  for (const w of ['x', 'verdict', 'null', 'enum', 'insufficient_data', 'insufficient', 'ok_or_tight', 'q3', 'данных мало', 'в горизонте нет']) set.add(w);
  return set;
}

/** Слова, которые НЕ могут быть вердиктом (старые словари, оценочные суждения): ERROR, а не просто «вне словаря». */
const BANNED_VERDICTS = new Set([
  'спокойно', 'нельзя', 'безопасно', 'опасно', 'рискованно', 'можно', 'хорошо', 'плохо', 'отлично', 'ок-ish',
  'safe', 'unsafe', 'risky', 'danger', 'caution', 'warning', 'good', 'bad', 'green', 'yellow', 'red', 'calm',
]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Основы, допускающие окончание: «гарантир» в изолированном виде не ловим (чужие функции: «гарантируют форму») — первое лицо ловит контекстное правило `we-guarantee`. */
const STEMS = new Set([]);

/** Правило-регэксп для фразы из `forbidden_phrases`: границы слова (Unicode); основы-«стемы» допускают окончание. */
function phrase_rule(phrase) {
  const body = esc(phrase).replace(/\s+/g, '\\s+');
  const tail = STEMS.has(phrase) ? '\\p{L}*' : '';
  return { id: 'forbidden:' + phrase, triggers: [phrase.toLowerCase().slice(0, 6)], re: new RegExp('(?<![\\p{L}\\d])' + body + tail + '(?![\\p{L}\\d])', 'giu'), level: 'error', msg: `запрещённая формулировка «${phrase}» (design-brief §10)` };
}

/** Контекстные правила §10, которые нельзя выразить простой фразой. */
const CONTEXT_RULES = [
  { id: 'safe-adjective', triggers: ['безопасн'], re: /(?<![\p{L}\d])безопасн(?:ая|ую|ой|ое|ые|ых|ым|ыми|ому)(?![\p{L}\d])/giu, level: 'error', msg: 'слово «безопасн…» запрещено в голосе продукта (C-063): «самая ранняя дата, с которой сумма держится в буфере»' },
  { id: 'we-guarantee', triggers: ['гарантир'], re: /(?<![\p{L}\d])(?:мы|runway|приложение)(?![\p{L}\d])\s+(?:гарантир\p{L}*|обещаем\s+точност\p{L}*)/giu, level: 'error', msg: '«гарантируем» запрещено: «расчёт по введённым данным; меняется, если данные неполны»' },
  { id: 'we-first', triggers: ['мы', 'runway', 'приложение', 'нет ни у кого'], re: /(?<![\p{L}\d])(?:мы|runway|приложение)(?![\p{L}\d])\s*[—:-]?\s*(?:первы[еймх]|единственн\p{L}*)(?![\p{L}\d])|(?<![\p{L}\d])нет\s+ни\s+у\s+кого(?![\p{L}\d])/giu, level: 'error', msg: '«первые/единственные/нет ни у кого» запрещено: «в изученных материалах (дата) не найдено»' },
  { id: 'calm-verdict', triggers: ['спокойно'], re: /(?:вердикт|оценка|ответ)[^.\n]{0,20}(?<![\p{L}\d])спокойно(?![\p{L}\d])|[«"]спокойно[»"]/giu, level: 'error', msg: 'слово «спокойно» как вердикт запрещено (§2.0, §10)' },
  { id: 'always-offline', triggers: ['always offline'], re: /(?<![\p{L}\d])always\s+offline(?![\p{L}\d])/giu, level: 'error', msg: '«всегда офлайн» запрещено (C-062): «после первой загрузки оболочки основные сценарии работают без сети»' },
  { id: 'first-forecast', triggers: ['первый прогноз'], re: /первый\s+прогноз\s+за\s+\d+\s+минут/giu, level: 'error', msg: '«первый прогноз за N минут» без измерения запрещено: «в тестах медиана — N минут (n = …, дата)»', promise: true },
  { id: 'spend-bare', triggers: ['можно потратить'], re: /можно\s+потратить\s+[\d\s ,.]+\s?[€$£₽]/giu, level: 'warn', msg: '«можно потратить X» без оговорки: «до {T} свободно X при буфере Y»' },
];

/** Контекст запрета: в этой же строке формулировка названа запрещённой / приведена как пример для линтера. */
const PROHIBITION_CONTEXT = /запрещ|нельзя|не\s+использ|не\s+пиш|не\s+допуска|не\s+говор|не\s+делаем|не\s+обещаем|не\s+обещает|вместо|forbidden|banned|снят[аоы]?(?![\p{L}])|отвергн|убран|удал[её]н|избега|линтер|lint(?![\p{L}])|ловит|(?<![\p{L}])FAIL(?![\p{L}])|не\s+подходит|плохо:|стоп-слов|слов[аоуе]?\s+[«"]|лозунг|формулир(?:овк|ует)|нет\s+слов|без\s+слов/iu;
/** Атрибуция заявления стороннего продукта (C-089). */
const ATTRIBUTION = /заявл|лендинг|budget\s*guru|(?<![\p{L}])BG(?![\p{L}])|аналог|terms|политик|цитат|в\s+кавычках|\(не\s+подтверждено\)|по\s+данным|по\s+утверждению|реклам/iu;
const ATTRIBUTION_DIRS = ['wiki/tools/', 'wiki/sources/', 'wiki/comparisons/', 'raw/'];
/** Каталоги-черновики («предложения, не решения», wiki/ideas): находки понижаются до предупреждений. */
const DOWNGRADE_DIRS = ['wiki/ideas/'];
const FORBIDDEN_HEADING = /нельзя|запрещ|forbidden|стоп-слов|банлист/iu;
const FORBIDDEN_TABLE_HEADER = /нельзя|запрещ|не\s+говорим|не\s+обещаем|forbidden|banned/iu;
/** Столбец таблицы с заявлениями стороннего продукта или списком «не делаем» — формулировки там приведены как чужие/запрещённые. */
const EXEMPT_COLUMN = /заявл|budget\s*guru|(?<![\p{L}])BG(?![\p{L}])|аналог|не\s+делаем|не\s+в\s+v1/iu;
const IGNORE_MARK = /<!--\s*lint-vocab:\s*ignore\s*-->/iu;

// ── сканирование текста ───────────────────────────────────────────────────────────────────────────────────────────────

/** Диапазоны кавычек в строке («…», “…”, "…") — для атрибутированных цитат. */
function quoted_ranges(line) {
  const out = [];
  for (const re of [/«[^»]*»/gu, /“[^”]*”/gu, /"[^"]*"/gu]) {
    for (const m of line.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/**
 * Зоны «приведено как запрещённое/чужое»: для каждой строки — `zone` (вся строка; таблица с заголовком «Нельзя…/Не говорим…», раздел «Нельзя…»)
 * и `cols` (индексы столбцов таблицы с заявлениями стороннего продукта или списком «не делаем»).
 * @param {string[]} lines
 * @returns {{zone: boolean[], cols: (Set<number>|null)[]}}
 */
function exempt_zones(lines) {
  const zone = new Array(lines.length).fill(false);
  const cols = new Array(lines.length).fill(null);
  const cells_of = (ln) => ln.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i])) {
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      const all = FORBIDDEN_TABLE_HEADER.test(lines[i]);
      const set = new Set();
      cells_of(lines[i]).forEach((c, k) => { if (EXEMPT_COLUMN.test(c)) set.add(k); });
      for (let k = i; k < j; k++) {
        if (all) zone[k] = true;
        if (set.size > 0) cols[k] = set;
      }
      i = j;
    } else i++;
  }
  let level = null;
  let fence = false;
  lines.forEach((ln, k) => {
    if (/^\s*\`\`\`/.test(ln)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*)$/.exec(ln);
    if (h !== null) {
      if (level !== null && h[1].length <= level) level = null;
      if (level === null && FORBIDDEN_HEADING.test(h[2])) level = h[1].length;
    }
    if (level !== null) zone[k] = true;
  });
  return { zone, cols };
}

/**
 * Проверить текст на запрещённые формулировки и вердикты вне словаря.
 * @param {string} text
 * @param {{file?: string, vocab?: object, golden?: Object<string, string>|null}} [opts]
 * @returns {{file: string, line: number, rule: string, level: 'error'|'warn', msg: string}[]}
 */
export function lint_text(text, opts = {}) {
  const file = opts.file ?? '<text>';
  const vocab = opts.vocab ?? load_vocab();
  const lines = text.split(/\r?\n/);
  const { zone, cols } = exempt_zones(lines);
  const downgrade = DOWNGRADE_DIRS.some((d) => file.replaceAll('\\', '/').includes(d));
  const attributed_dir = ATTRIBUTION_DIRS.some((d) => file.replaceAll('\\', '/').includes(d));
  const rules = [...(vocab.forbidden_phrases ?? []).map(phrase_rule), ...CONTEXT_RULES];
  const found = new Map();
  const add = (line, rule, level, msg) => {
    const key = (line + 1) + '|' + rule;
    if (!found.has(key)) found.set(key, { file, line: line + 1, rule, level, msg });
  };
  const allowed = allowed_verdict_words(vocab);
  const seen_span = new Set();
  lines.forEach((ln, idx) => {
    if (IGNORE_MARK.test(ln) || (idx > 0 && IGNORE_MARK.test(lines[idx - 1]))) return;
    const low = ln.toLowerCase();
    let lazy = null; // тяжёлые проверки контекста — только для строк, где сработал триггер
    const line_ctx = () => (lazy ??= { prohibited_here: zone[idx] || PROHIBITION_CONTEXT.test(ln), quotes: quoted_ranges(ln) });
    const cell_of = (pos) => ln.slice(0, pos).split('|').length - 2; // индекс ячейки таблицы (строка начинается с «|»)
    for (const rule of rules) {
      if (!rule.triggers.some((tr) => low.includes(tr))) continue;
      rule.re.lastIndex = 0;
      for (const m of ln.matchAll(rule.re)) {
        const span = idx + ':' + m.index;
        if (seen_span.has(span)) continue; // одна и та же позиция — одним правилом
        const { prohibited_here, quotes } = line_ctx();
        if (prohibited_here) continue;
        if (/(?<![\p{L}])не\s+$/iu.test(ln.slice(0, m.index))) continue; // отрицание: «не гарантируем»
        const in_quote = quotes.some(([a, b]) => m.index >= a && m.index < b);
        if (attributed_dir && (ATTRIBUTION.test(ln) || in_quote)) continue;
        if (in_quote && ATTRIBUTION.test(ln)) continue; // цитата заявления аналога с атрибуцией (C-089) — в любом каталоге
        if (cols[idx] !== null && cols[idx].has(cell_of(m.index))) continue;
        seen_span.add(span);
        add(idx, rule.id, downgrade ? 'warn' : rule.level, rule.msg);
      }
    }
    // вердикты вне словаря: `verdict = «X»` и «Вердикт: X»
    const has_verdict_word = low.includes('verdict') || low.includes('вердикт') || low.includes('оценка:');
    const verdicts = !has_verdict_word ? [] : [
      ...ln.matchAll(/verdict\s*[=:]\s*[`'"«]([A-Za-zА-Яа-яёЁ_ ]{1,20})[`'"»]/giu),
      ...ln.matchAll(/вердикт(?:\s*[:—-]|\s+—)\s*[«"`]?([A-Za-zА-Яа-яёЁ_]+(?: [а-яё]+)?)/giu),
      ...ln.matchAll(/(?<![\p{L}])оценка:\s*([А-Яа-яёЁ]+(?: [а-яё]+)?)/gu),
    ];
    for (const m of verdicts) {
      if (line_ctx().prohibited_here || (attributed_dir && ATTRIBUTION.test(ln))) continue;
      const w = m[1].trim().toLowerCase();
      const first = w.split(' ')[0];
      if (BANNED_VERDICTS.has(w) || BANNED_VERDICTS.has(first)) add(idx, 'verdict-banned', downgrade ? 'warn' : 'error', `вердикт «${m[1].trim()}» не из словаря §2.0 (OK, TIGHT, FRAGILE, NO)`);
      else if (!allowed.has(w) && !allowed.has(first) && /verdict|оценка/iu.test(m[0]) && /[`'"«]/.test(m[0]) && m[0].toLowerCase().startsWith('verdict')) {
        add(idx, 'verdict-unknown', 'warn', `значение вердикта «${m[1].trim()}» вне словаря §2.0`);
      }
    }
  });
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/**
 * Метки `<!--num:KEY=VALUE-->`: значение сверяется с golden-выводом; расхождение — ERROR, неизвестный ключ — предупреждение.
 * @param {string} text
 * @param {{file?: string, golden: Object<string, string>}} opts
 */
export function lint_num_labels(text, opts) {
  const file = opts.file ?? '<text>';
  const out = [];
  text.split(/\r?\n/).forEach((ln, idx) => {
    for (const m of ln.matchAll(/<!--\s*num:([A-Za-z0-9_.-]+)=([^\s>]*?)\s*-->/g)) {
      const g = opts.golden?.[m[1]];
      if (g === undefined) out.push({ file, line: idx + 1, rule: 'num-unknown', level: 'warn', msg: `метка num:${m[1]} — нет golden-значения` });
      else if (String(g) !== m[2]) out.push({ file, line: idx + 1, rule: 'num-mismatch', level: 'error', msg: `метка num:${m[1]}=${m[2]} не совпадает с golden-выводом (${g})` });
    }
  });
  return out;
}

const DAY_MS = 86400000;
function iso_to_day(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (m === null) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/**
 * Реестр обещаний: `level = hypothesis` в интерфейсе, `measured` старше 90 дней (или без даты измерения), «первый прогноз за N минут» без измерения → ERROR.
 * Запись: `{id, text, level: 'hypothesis'|'measured', surface?: 'ui'|'doc', measured_on?: 'YYYY-MM-DD'}`.
 * @param {object[]} registry
 * @param {string} today IsoDate
 * @param {string} [file]
 */
export function lint_promises(registry, today, file = '<registry>') {
  const out = [];
  const t = iso_to_day(today);
  (registry ?? []).forEach((p, i) => {
    const where = { file, line: i + 1 };
    const label = p.id ?? 'promise#' + i;
    if (p.level === 'hypothesis' && p.surface === 'ui') out.push({ ...where, rule: 'promise-hypothesis-in-ui', level: 'error', msg: `обещание «${label}» с level = hypothesis показано в интерфейсе` });
    if (p.level === 'measured') {
      const d = iso_to_day(p.measured_on);
      if (d === null) out.push({ ...where, rule: 'promise-no-date', level: 'error', msg: `обещание «${label}» отмечено measured без даты измерения` });
      else if (t !== null && t - d > 90) out.push({ ...where, rule: 'promise-stale', level: 'error', msg: `измерение «${label}» старше 90 дней (${p.measured_on})` });
    }
    if (/первый\s+прогноз\s+за\s+\d+\s+минут/iu.test(String(p.text ?? '')) && p.level !== 'measured') {
      out.push({ ...where, rule: 'first-forecast', level: 'error', msg: `«первый прогноз за N минут» без измерения (обещание «${label}»)` });
    }
  });
  return out;
}

// ── императивы в каталогах строк интерфейса (REQ-046, REQ-114) ─────────────────────────────────────────────────────────────

/**
 * Повелительные формы, допустимые в интерфейсе: «проверьте», «введите», «сверьте» (REQ-046) и их английские параллели
 * (check, enter, reconcile/compare). Всё остальное в i18n-каталогах (`добавьте …`, `Заполните поля`, `Нажмите …`) — нейтральные формулировки:
 * «поступление не внесено», «поля не заполнены», «кнопка «Сохранить»». Список живёт здесь, а не в `vocab.json` (FP-25).
 */
export const ALLOWED_IMPERATIVES = Object.freeze({
  ru: Object.freeze(['проверьте', 'введите', 'сверьте']),
  en: Object.freeze(['check', 'enter', 'reconcile', 'compare']),
});

/** RU: форма 2-го лица множественного числа повелительного наклонения (-йте/-ьте/-ите, возвратная -сь); «хотите», «видите» и т. п. — не повеление. */
const RU_IMPERATIVE_RE = /(?<![\p{L}\d])[а-яё]+(?:йте|ьте|ите)(?:сь)?(?![\p{L}\d])/giu;
/** Формы на -ите, которые в каталогах не повелительное наклонение (изъявительное «вы хотите», «вы видите»). */
const RU_NOT_IMPERATIVE = new Set(['хотите', 'видите', 'знаете', 'платите', 'сайте', 'элите']);
/**
 * Слово перед формой, при котором она изъявительная: «правила, которые вводите вы», «если хотите», «как вводите»;
 * между ним и формой допустимы «сами / не / уже / ещё / же» («пока вы сами не подтвердите», «если вы ещё не введёте»).
 */
const RU_INDICATIVE_BEFORE = /(?:^|[\s,;:(«"])(?:вы|если|которые|который|которое|что|как|когда|пока|где|кто|чтобы)\s+(?:(?:сами|сама|сам|не|уже|ещё|еще|же|тоже)\s+){0,2}$/iu;
/** Слово после формы: «вводите вы», «вносите вы сами» — подлежащее называет, кто вводит (изъявительное). */
const RU_INDICATIVE_AFTER = /^\s+вы(?![\p{L}\d])/iu;

/**
 * EN: глаголы, которые в предложении-указании читаются как команда (первый заслон: известные глаголы, в том числе без прямого дополнения —
 * «Wait.», «Try again», «Be careful»). Допустимые (check, enter, reconcile, compare) сюда не входят. Список открытый, а не исчерпывающий: любой
 * другой глагол в начале предложения ловит второй заслон (`EN_GENERIC_RE`, «глагол + артикль/местоимение-дополнение»), а отрицательные команды
 * («Do not …», «Don't …», «Never …») — третий (`EN_NEGATIVE_RE`). Существительные, совпадающие с глаголом (`log`, `group`, `count`, …), сюда не вносят.
 */
const EN_IMPERATIVE_VERBS = Object.freeze([
  'add', 'fill', 'select', 'choose', 'click', 'tap', 'press', 'open', 'update', 'change', 'set', 'confirm', 'remove', 'delete', 'save', 'download',
  'use', 'try', 'retry', 'wait', 'close', 'restart', 'reload', 'copy', 'paste', 'clear', 'create', 'write', 'type', 'pick', 'tick', 'untick', 'mark',
  'skip', 'cancel', 'apply', 'reset', 'link', 'continue', 'review', 'fix', 'look', 'see', 'note', 'keep', 'leave', 'make', 'take', 'give', 'ask',
  'name', 'split', 'merge', 'combine', 'move', 'pin', 'turn', 'switch', 'go', 'refresh', 'run', 'load', 'upload', 'import', 'export', 'print',
  'show', 'hide', 'share', 'replace', 'edit', 'start', 'stop', 'undo', 'redo', 'restore', 'record', 'remind', 'measure', 'calculate', 'recalculate',
  'do', 'pass', 'read', 'allow', 'enable', 'disable', 'insert', 'provide', 'specify', 'list', 'pay', 'drop', 'return', 'finish', 'complete', 'report',
  'send', 'submit', 'accept', 'decide', 'consider', 'avoid', 'ensure', 'verify', 'wipe', 'erase', 'overwrite', 'rename', 'sort', 'filter', 'follow',
  'contact', 'ignore', 'pause', 'resume', 'unlink', 'attach', 'detach',
  // дополнение FP-25 (исправление после проверки): «Adjust / Visit / Install / Increase / Put / Let / Be …»
  'adjust', 'visit', 'install', 'increase', 'decrease', 'reduce', 'raise', 'lower', 'put', 'let', 'be', 'bring', 'find', 'remember', 'consult',
  'activate', 'deactivate', 'expand', 'collapse', 'scroll', 'drag', 'navigate', 'browse', 'supply', 'describe', 'explain', 'define', 'mention',
  'indicate', 'grant', 'deny', 'approve', 'reject', 'refuse', 'decline', 'agree', 'register', 'subscribe', 'join', 'quit', 'abort', 'halt', 'begin',
  'execute', 'perform', 'generate', 'produce', 'compose', 'prepare', 'buy', 'spend', 'retain', 'preserve', 'protect', 'unlock',
  'encrypt', 'decrypt', 'swap', 'convert', 'translate', 'truncate', 'duplicate', 'clone', 'prioritize', 'deselect', 'uncheck', 'attempt',
  'resync', 'downgrade', 'repair', 'recover', 'revert', 'discard', 'dismiss', 'purge', 'trash', 'inspect', 'examine', 'validate', 'double-check',
  'recheck', 'imagine', 'assume',
]);
/** EN: позиции, где начинается повелительное предложение: начало строки, после точки/двоеточия/тире/точки с запятой, после запятой, «and/or/then». */
const EN_BOUNDARY = String.raw`(?:^|[.!?:;—·]\s+|\(\s*|,\s+(?:then\s+|and\s+|or\s+)?|\s+(?:and|or|then|and then)\s+)(?:please\s+)?`;
/** EN: позиции начала предложения без «and/or/then» и запятой — для второго и третьего заслонов (после «and» базовая форма может быть сказуемым множественного числа). */
const EN_SENTENCE_START = String.raw`(?:^|[.!?:;—·]\s+|\(\s*)(?:please\s+)?`;
/** EN: после глагола не должно идти слово, делающее его существительным или названием элемента («Copy of …», «Review not marked», «Undo restores …», «change against the base»). */
const EN_NOT_VERB_AFTER = String.raw`(?!,|:|\s+(?:of|not|is|was|are|were|has|have|will|would|can|could|may|against|restores|brings|keeps|removes|returns|changes|reverts)(?![\p{L}\d]))`;
const EN_IMPERATIVE_RE = new RegExp('(' + EN_BOUNDARY + ')(' + EN_IMPERATIVE_VERBS.join('|') + ')' + String.raw`(?![\p{L}\d'’-])` + EN_NOT_VERB_AFTER, 'giu');

/**
 * EN, второй заслон: слово в начале предложения + артикль, указательное или местоимение-дополнение («Adjust the buffer», «Visit your settings»).
 * Подлежащее не может стоять непосредственно перед артиклем, поэтому такое слово — переходный глагол в повелительном наклонении, каким бы он ни был
 * (список глаголов не нужен). Исключения — закрытые классы: служебные слова (предлоги, союзы, вспомогательные глаголы, наречия) и формы, которые
 * не бывают повелительными: на -ing («Closing the window …»), на -ed («Saved the …») и третье лицо на одиночное -s («Records the posted income …»).
 */
const EN_OBJECT_STARTERS = String.raw`(?:the|a|an|this|these|those|your|my|our|its|their|his|her|it|them|him|us|each|every|another)`;
const EN_GENERIC_RE = new RegExp('(' + EN_SENTENCE_START + ')([A-Za-z][A-Za-z\'’-]*)\\s+' + EN_OBJECT_STARTERS + String.raw`(?![\p{L}\d'’-])`, 'gu');
/** EN: служебные слова — предложение, начатое ими, не повеление (закрытый класс; новые слова вносят сюда после разбора находки). */
const EN_FUNCTION_WORDS = new Set((
  'a an the this that these those there here their they them it its is are was were be been being has have had can could will would may might must should shall does did ' +
  'not no nor and or but so yet if when while because as after before once until since unless although though for in on at by with without from of to into onto within ' +
  'between under over during per about above below beyond across through toward towards than then thus hence now only also just such quite even still too very more ' +
  'most less least much many few several some any all both either neither each every other another one two three four five six seven eight nine ten first last next ' +
  'previous same whole whether what which who whom whose how why where we you i he she me my our your his her everything nothing something anything everyone someone ' +
  'nobody whoever whatever otherwise later earlier currently today tomorrow yesterday again instead meanwhile however therefore moreover besides except despite among ' +
  'around along against upon via versus plus minus like unlike half twice always often usually sometimes soon already almost nearly rather perhaps maybe too yes ' +
  'either whenever wherever however regardless unlike beside beneath inside outside near off up down out away back'
).split(/\s+/));
/** EN: слова на -ing / -ed / одиночное -s не бывают повелительными для второго заслона (исключения-глаголы вносятся в `EN_IMPERATIVE_VERBS`). */
const EN_NOT_IMPERATIVE_SHAPE = /(?:ing|ed|(?<![su])s)$/i;
/**
 * EN, третий заслон: отрицательные команды в начале предложения или после «;» — «Do not …», «Don't …», «Never share …».
 * «Never» считается командой, если следом базовая форма глагола и дополнение или конец предложения («Never share the file.»); «Never sent.» — нет.
 */
const EN_NEGATIVE_RE = new RegExp('(' + EN_SENTENCE_START + ')(do\\s+not|don[\'’]t|do\\s+n[\'’]t)(?![\\p{L}\\d])', 'giu');
const EN_NEVER_RE = new RegExp('(' + EN_SENTENCE_START + ')(never)\\s+([a-z]+)(?=\\s+' + EN_OBJECT_STARTERS + '(?![\\p{L}\\d])|\\s*[.!]|\\s*$)', 'giu');

/**
 * Повелительные формы в одной строке каталога.
 * @param {string} text
 * @param {'ru'|'en'} lang
 * @returns {{word: string, index: number}[]} недопустимые императивы (допустимые из `ALLOWED_IMPERATIVES` пропущены)
 */
export function find_imperatives(text, lang) {
  const out = [];
  const allowed = new Set(ALLOWED_IMPERATIVES[lang] ?? []);
  const plain = String(text);
  if (lang === 'ru') {
    for (const m of plain.matchAll(RU_IMPERATIVE_RE)) {
      const w = m[0].toLowerCase();
      if (allowed.has(w) || RU_NOT_IMPERATIVE.has(w)) continue;
      if (RU_INDICATIVE_BEFORE.test(plain.slice(0, m.index)) || RU_INDICATIVE_AFTER.test(plain.slice(m.index + m[0].length))) continue;
      out.push({ word: m[0], index: m.index });
    }
  } else if (lang === 'en') {
    // Подписи кнопок и ссылок («Add to the forecast», «Undo the last action») по-английски повелительные по форме; предложением-указанием строка считается,
    // только если заканчивается точкой или восклицательным знаком: вопрос («Replace the saved data?») — название окна, а не команда
    // (RU-пары проверяются без такого послабления: там подписи — инфинитивы).
    if (!/[.!][\s"”»')]*$/u.test(plain.trimEnd())) return out;
    const seen = new Set();
    const put = (word, index) => {
      if (seen.has(index)) return;
      seen.add(index);
      out.push({ word, index });
    };
    // 1) известные глаголы-команды
    for (const m of plain.matchAll(EN_IMPERATIVE_RE)) {
      const w = m[2].toLowerCase();
      if (allowed.has(w)) continue;
      put(m[2], m.index + m[1].length);
    }
    // 2) любой другой переходный глагол в начале предложения: «Adjust the buffer.» (слово + артикль/местоимение-дополнение)
    for (const m of plain.matchAll(EN_GENERIC_RE)) {
      const w = m[2].toLowerCase();
      if (allowed.has(w) || EN_FUNCTION_WORDS.has(w) || EN_NOT_IMPERATIVE_SHAPE.test(w)) continue;
      put(m[2], m.index + m[1].length);
    }
    // 3) отрицательные команды: «Do not …», «Don't …», «Never share …»
    for (const m of plain.matchAll(EN_NEGATIVE_RE)) put(m[2], m.index + m[1].length);
    for (const m of plain.matchAll(EN_NEVER_RE)) {
      if (EN_NOT_IMPERATIVE_SHAPE.test(m[3]) || /^(?:been|being|sent|seen|shown|done|gone|given|taken|known|kept|left|held|lost|made|written)$/i.test(m[3])) continue;
      put(m[2], m.index + m[1].length);
    }
    out.sort((a, b) => a.index - b.index);
  }
  return out;
}

/**
 * Каталоги строк интерфейса: `demo/i18n.mjs` (STRINGS) и `demo/i18n/*.mjs` (export default {ru, en}).
 * @param {string} [root]
 * @returns {Promise<{file: string, ru: Object<string,string>, en: Object<string,string>}[]>}
 */
export async function load_catalogs(root = ROOT) {
  const demo = join(root, 'prototype', 'demo');
  const out = [];
  const base = await import(pathToFileURL(join(demo, 'i18n.mjs')).href);
  out.push({ file: 'prototype/demo/i18n.mjs', ru: base.STRINGS.ru, en: base.STRINGS.en });
  const dir = join(demo, 'i18n');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) {
      const cat = (await import(pathToFileURL(join(dir, name)).href)).default;
      out.push({ file: 'prototype/demo/i18n/' + name, ru: cat.ru, en: cat.en });
    }
  }
  return out;
}

/**
 * Тексты, которые попадают на экран мимо каталогов `demo/i18n*`: шаблоны ответов `engine/verifier.mjs` (`templates('ru'|'en')`, в том числе подписи операций
 * черновика `DRAFT.*`) и шаблон-скелет мастера «Старт» (`demo/start_template.mjs`: пары `{ru, en}`). REQ-046 действует и для них (FP-25, исправление
 * после проверки). Отдельная функция, а не часть `load_catalogs`: каталоги интерфейса и шаблоны — разные наборы (число каталогов закреплено тестами).
 * @param {string} [root]
 * @returns {Promise<{file: string, ru: Object<string,string>, en: Object<string,string>}[]>}
 */
export async function load_template_catalogs(root = ROOT) {
  const out = [];
  const verifier = await import(pathToFileURL(join(root, 'prototype', 'engine', 'verifier.mjs')).href);
  out.push({ file: 'prototype/engine/verifier.mjs', ru: { ...verifier.templates('ru') }, en: { ...verifier.templates('en') } });
  const start = await import(pathToFileURL(join(root, 'prototype', 'demo', 'start_template.mjs')).href);
  const ru = {};
  const en = {};
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (typeof node.ru === 'string' && typeof node.en === 'string') { ru[path] = node.ru; en[path] = node.en; return; }
    for (const [k, v] of Object.entries(node)) walk(v, path === '' ? k : path + '.' + k);
  };
  walk(start.TEMPLATES, '');
  out.push({ file: 'prototype/demo/start_template.mjs', ru, en });
  return out;
}

/**
 * Недопустимые императивы в каталогах строк — ERROR (REQ-046: на экране нет ни одного императива, кроме «проверьте», «введите», «сверьте»).
 * Номер строки — место ключа в исходнике каталога: для RU первое вхождение ключа, для EN второе (каталог пишется как `ru: {…}`, затем `en: {…}`);
 * если файл не читается или ключ не найден — 1.
 * @param {{file: string, ru: Object<string,string>, en: Object<string,string>}[]} catalogs
 * @param {{root?: string}} [opts]
 * @returns {{file: string, line: number, rule: string, level: 'error', msg: string}[]}
 */
export function lint_imperatives(catalogs, opts = {}) {
  const root = opts.root ?? ROOT;
  const out = [];
  for (const cat of catalogs) {
    let src_lines = null;
    try { src_lines = readFileSync(join(root, cat.file), 'utf8').split(/\r?\n/); } catch { src_lines = null; }
    const line_of = (key, lang) => {
      if (src_lines === null) return 1;
      const q = [`'${key}'`, `"${key}"`, `${key}:`];
      const at = [];
      src_lines.forEach((ln, i) => { if (q.some((p) => ln.trimStart().startsWith(p))) at.push(i); });
      if (at.length === 0) return 1;
      return (lang === 'en' && at.length > 1 ? at[1] : at[0]) + 1;
    };
    for (const lang of ['ru', 'en']) {
      for (const [key, text] of Object.entries(cat[lang] ?? {})) {
        const hits = find_imperatives(text, lang);
        if (hits.length === 0) continue;
        const words = [...new Set(hits.map((h) => h.word.toLowerCase()))].join(', ');
        out.push({ file: cat.file, line: line_of(key, lang), rule: 'imperative', level: 'error', msg: `${key} (${lang}): императив «${words}» — допустимы только ${ALLOWED_IMPERATIVES[lang].join(' / ')}; нейтральная формулировка (REQ-046)` });
      }
    }
  }
  return out;
}

// ── golden-значения из движка ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Golden-вывод G-001 для меток `num:` — считается движком на prototype/data/g001.json (числа канона §9, не копии).
 * @returns {Promise<Object<string, string>>}
 */
export async function golden_values(root = ROOT) {
  const e = await import(pathToFileURL(join(root, 'prototype', 'engine', 'index.mjs')).href);
  const ws = JSON.parse(readFileSync(join(root, 'prototype', 'data', 'g001.json'), 'utf8'));
  const ctx = e.analyze(ws, { as_of: ws.as_of });
  const g = {};
  const put = (k, v) => { g['G-001.' + k] = String(v); };
  const last = (s) => s.close[s.close.length - 1];
  put('opening', ctx.series.plan.opening_minor);
  put('end_close', last(ctx.series.plan));
  put('q1.min_trough.plan', ctx.q1.plan.min);
  put('q1.min_trough.worse', ctx.q1.worse.min);
  for (const m of ['plan', 'worse']) put('free.min.' + m, Math.min(...ctx.series[m].free));
  put('reserve_close.end', ctx.series.plan.reserve_close[ctx.series.plan.reserve_close.length - 1]);
  const w_plan = e.list_waves(ctx, 'plan');
  const w_worse = e.list_waves(ctx, 'worse');
  put('waves.w1.need.plan', w_plan[0].metrics.need_minor);
  put('waves.w1.need.worse', w_worse[0].metrics.need_minor);
  put('waves.w2.need', w_plan[1].metrics.need_minor);
  const q3 = e.check_purchase(ctx, { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }] });
  put('q3.treadmill.m_after.plan', q3.by_mode.plan.m_after);
  put('q3.treadmill.m_after.worse', q3.by_mode.worse.m_after);
  put('q3.treadmill.verdict', q3.verdict);
  const buy_day = e.to_epoch_day('2026-10-12');
  for (const m of ['plan', 'worse']) put('q3.s_max.' + m, e.max_amount(ctx, buy_day, ctx.buffer_minor, m)); // G-001.q3.s_max (golden-файл: 43500 / 21000)
  put('safe_to_spend.plan', e.safe_to_spend(ctx, '2026-11-19', null, 'plan').sts);
  put('safe_to_spend.worse', e.safe_to_spend(ctx, '2026-11-19', null, 'worse').sts);
  return g;
}

// ── покрытие метками чисел G-001 (REQ-177, режим --coverage) ──────────────────────────────────────────────────────────

const LABEL_RE = /<!--\s*num:([A-Za-z0-9_.-]+)=([^\s>]*?)\s*-->/g;
const IGNORE_LINE_RE = /<!--\s*lint-vocab:\s*ignore\s*-->/;
const KEY_REF_RE = /G-001\.[A-Za-z0-9_.-]*[A-Za-z0-9_]/g;
const GROUP_SEP = '[\\s\\u00a0\\u202f.,]?';

/**
 * Числа G-001, по которым считается покрытие: значения golden-вывода, похожие на суммы в минимальных единицах (положительные целые не короче трёх знаков).
 * @param {Object<string, string>} golden результат `golden_values()`
 * @returns {Map<string, string[]>} значение (строка цифр) → ключи golden с этим значением, по алфавиту
 */
export function golden_numbers(golden) {
  const out = new Map();
  for (const [k, v] of Object.entries(golden ?? {})) {
    if (!/^[1-9]\d{2,}$/.test(String(v))) continue;
    if (!out.has(String(v))) out.set(String(v), []);
    out.get(String(v)).push(k);
  }
  for (const keys of out.values()) keys.sort();
  return out;
}

/** Регулярные выражения записи числа: целое как есть («205500») и сумма с двумя знаками («2 055,00», «2055.00», «2.055,00»). */
function number_regexes(numbers) {
  const out = [];
  for (const value of numbers.keys()) {
    const whole = String(Math.floor(Number(value) / 100));
    const frac = String(Number(value) % 100).padStart(2, '0');
    const grouped = whole.length > 3 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, '#').split('#').join(GROUP_SEP) : whole;
    out.push({ value, re: new RegExp('(?<!\\d)' + value + '(?!\\d|[.,]\\d)', 'g') });
    out.push({ value, re: new RegExp('(?<!\\d)' + grouped + '[.,]' + frac + '(?!\\d)', 'g') });
  }
  return out;
}

/**
 * Числа G-001 страницы без метки. Число покрыто, если в той же строке есть метка `<!--num:KEY=ЗНАЧЕНИЕ-->` с тем же значением, ссылка на ключ `G-001.<имя>`
 * с тем же golden-значением (таблица ключей) или комментарий `<!-- lint-vocab: ignore -->` в этой либо предыдущей строке. Сами метки числами не считаются.
 * @param {string} text
 * @param {{file?: string, golden: Object<string, string>}} opts
 * @returns {{file: string, found: number, labeled: number, missing: {line: number, value: string, keys: string[], shown: string, text: string}[]}}
 */
export function scan_coverage(text, opts) {
  const file = opts.file ?? '<text>';
  const numbers = golden_numbers(opts.golden);
  const regexes = number_regexes(numbers);
  const lines = text.split(/\r?\n/);
  const missing = [];
  let found = 0;
  let labeled = 0;
  lines.forEach((ln, idx) => {
    const covered = new Set();
    for (const m of ln.matchAll(LABEL_RE)) covered.add(m[2]);
    for (const m of ln.matchAll(KEY_REF_RE)) if (opts.golden?.[m[0]] !== undefined) covered.add(String(opts.golden[m[0]]));
    const ignored = IGNORE_LINE_RE.test(ln) || (idx > 0 && IGNORE_LINE_RE.test(lines[idx - 1]));
    const bare = ln.replace(LABEL_RE, (c) => ' '.repeat(c.length)); // число внутри метки — не отдельное вхождение
    const seen = new Set();
    for (const { value, re } of regexes) {
      for (const m of bare.matchAll(re)) {
        if (seen.has(m.index + ':' + value)) continue;
        seen.add(m.index + ':' + value);
        found += 1;
        if (covered.has(value) || ignored) { labeled += 1; continue; }
        missing.push({ line: idx + 1, value, keys: numbers.get(value), shown: m[0], text: ln.trim().slice(0, 160) });
      }
    }
  });
  missing.sort((a, b) => a.line - b.line || a.value.localeCompare(b.value));
  return { file, found, labeled, missing };
}

/**
 * Покрытие по wiki/**\/*.md: числа G-001 без метки по страницам. Только чтение.
 * @param {{root?: string, golden: Object<string, string>}} opts
 * @returns {{pages: number, found: number, labeled: number, missing: number, files: {file: string, found: number, labeled: number, missing: object[]}[]}}
 */
export function coverage_project(opts) {
  const root = opts.root ?? ROOT;
  const files = [];
  let found = 0;
  let labeled = 0;
  let missing = 0;
  const targets = walk_files(join(root, 'wiki'), new Set(['.md']));
  for (const f of targets) {
    const r = scan_coverage(readFileSync(f, 'utf8'), { file: relative(root, f).split(sep).join('/'), golden: opts.golden });
    found += r.found;
    labeled += r.labeled;
    missing += r.missing.length;
    if (r.found > 0) files.push(r);
  }
  return { pages: targets.length, found, labeled, missing, files };
}

/** Текст отчёта `--coverage`: по страницам, строка за строкой (не больше `limit` строк), затем итог. Режим только перечисляет: код выхода 0. */
export function format_coverage(r, opts = {}) {
  const limit = opts.limit ?? 200;
  const out = ['Числа G-001 без метки num: (REQ-177) — перечень; метка ставится рядом с числом: <!--num:G-001.ключ=значение-->'];
  let printed = 0;
  for (const f of r.files) {
    if (f.missing.length === 0) continue;
    out.push(`\n${f.file}: без метки ${f.missing.length} из ${f.found}`);
    for (const m of f.missing) {
      if (printed >= limit) break;
      out.push(`  ${f.file}:${m.line}: ${m.shown} (${m.keys.join(' | ')})`);
      printed += 1;
    }
  }
  if (printed < r.missing) out.push(`\n… показано ${printed} из ${r.missing} (--limit N — больше строк)`);
  out.push(`\nИтого: чисел G-001 на страницах вики — ${r.found}, с меткой или ссылкой на ключ — ${r.labeled}, без метки — ${r.missing} (страниц с числами: ${r.files.length} из ${r.pages}). Режим только перечисляет: код выхода 0`);
  return out.join('\n') + '\n';
}

/**
 * Заменить комментарии JS пробелами (переводы строк сохраняются): комментарий — не голос продукта.
 * Разбор простой: строки '…', "…", шаблоны `…` и regex-литералы не трогаются (regex распознаётся по контексту «после ( , = : [ ! & | ? { } ; return»).
 * @param {string} src
 * @returns {string}
 */
export function strip_js_comments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const NL = String.fromCharCode(10);
  const BS = String.fromCharCode(92);
  let quote = null;
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === BS) { out += nx ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && nx === '/') {
      while (i < n && src[i] !== NL) { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && nx === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === NL ? NL : ' '; i += 1; }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

// ── обход файлов ──────────────────────────────────────────────────────────────────────────────────────────────────────

const TEXT_EXT = new Set(['.md', '.html', '.htm', '.js', '.mjs', '.json', '.css', '.txt']);

function walk_files(dir, exts) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk_files(p, exts));
    else if (exts.has(name.slice(name.lastIndexOf('.')).toLowerCase())) out.push(p);
  }
  return out;
}

// ── реестр исключений для предупреждений (FP-25, REQ-178) ──────────────────────────────────────────────────────────────────

/** Путь к реестру исключений по умолчанию: `tools/lint_vocab_ignore.json` (рядом с линтером). */
export const IGNORE_PATH = join(ROOT, 'tools', 'lint_vocab_ignore.json');

/**
 * Прочитать и проверить реестр исключений. Запись: `{file, rule, count, reason}` — в файле `file` (путь от корня runway, `/`) ровно `count` предупреждений
 * правила `rule` разобраны и объяснены в `reason`. Исключить можно только предупреждения (`warn`): ошибки реестром не снимаются.
 * Пометка в самой странице (`<!-- lint-vocab: ignore -->`) по-прежнему действует; реестр нужен там, где страницу правит не автор линтера (черновики wiki/ideas).
 * @param {string} [path]
 * @returns {{file: string, rule: string, count: number, reason: string}[]}
 * @throws {Error} запись без файла, правила, целого `count` ≥ 1 или без причины
 */
export function load_ignore(path = IGNORE_PATH) {
  if (!existsSync(path)) return [];
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(j?.entries) ? j.entries : [];
  list.forEach((e, i) => {
    const bad = typeof e?.file !== 'string' || e.file === '' || typeof e?.rule !== 'string' || e.rule === '' || !Number.isInteger(e?.count) || e.count < 1 || typeof e?.reason !== 'string' || e.reason.trim().length < 20;
    if (bad) throw new Error(`lint_vocab_ignore: запись ${i + 1} без file, rule, count ≥ 1 или причины (reason ≥ 20 символов)`);
  });
  return list;
}

/**
 * Применить реестр исключений: у каждой записи первые `count` предупреждений (по порядку строк) её файла и правила уходят в `ignored`;
 * лишние остаются предупреждениями (новое нарушение не прячется), недостающие дают предупреждение `ignore-stale` (запись устарела).
 * @param {object[]} findings
 * @param {{file: string, rule: string, count: number, reason: string}[]} entries
 * @returns {{kept: object[], ignored: object[], stale: object[]}}
 */
export function apply_ignore(findings, entries) {
  const ignored = [];
  const taken = new Set();
  const stale = [];
  entries.forEach((e, i) => {
    const mine = findings
      .filter((f) => f.level === 'warn' && f.file === e.file && f.rule === e.rule && !taken.has(f))
      .sort((a, b) => a.line - b.line);
    const use = mine.slice(0, e.count);
    for (const f of use) { taken.add(f); ignored.push({ ...f, reason: e.reason }); }
    if (use.length < e.count) stale.push({ file: 'tools/lint_vocab_ignore.json', line: i + 1, rule: 'ignore-stale', level: 'warn', msg: `запись исключения для ${e.file} [${e.rule}] ждала ${e.count}, найдено ${use.length}: обновите или удалите запись` });
  });
  return { kept: findings.filter((f) => !taken.has(f)), ignored, stale };
}

/**
 * Просканировать каталоги проекта: wiki/**\/*.md и prototype/demo (текстовые файлы) + дополнительные каталоги.
 * @param {{root?: string, dirs?: string[], today?: string, registry?: object[]|null, golden?: Object<string,string>|null, vocab?: object, ignore?: object[]|null, catalogs?: object[]|null}} [opts]
 *   `ignore` — записи `load_ignore()` (по умолчанию не применяются); `catalogs` — результат `load_catalogs()` для проверки императивов (REQ-046)
 * @returns {{files: number, lines: number, findings: object[], ignored?: object[]}}
 */
export function lint_project(opts = {}) {
  const root = opts.root ?? ROOT;
  const vocab = opts.vocab ?? load_vocab(join(root, 'prototype', 'engine', 'vocab.json'));
  const targets = [
    ...walk_files(join(root, 'wiki'), new Set(['.md'])),
    ...walk_files(join(root, 'prototype', 'demo'), TEXT_EXT),
    ...(opts.dirs ?? []).flatMap((d) => walk_files(resolve(d), TEXT_EXT)),
  ];
  const findings = [];
  let lines = 0;
  for (const f of targets) {
    const text = readFileSync(f, 'utf8');
    const rel = relative(root, f).split(sep).join('/');
    lines += text.split('\n').length;
    const voice = /\.(?:m?js)$/i.test(f) ? strip_js_comments(text) : text; // в коде голос продукта — строки, а не комментарии разработчика
    findings.push(...lint_text(voice, { file: rel, vocab }));
    if (opts.golden !== undefined && opts.golden !== null) findings.push(...lint_num_labels(text, { file: rel, golden: opts.golden }));
  }
  if (opts.registry !== undefined && opts.registry !== null) findings.push(...lint_promises(opts.registry, opts.today ?? '1970-01-01', 'registry'));
  if (opts.catalogs !== undefined && opts.catalogs !== null) findings.push(...lint_imperatives(opts.catalogs, { root }));
  if (opts.ignore !== undefined && opts.ignore !== null && opts.ignore.length > 0) {
    const r = apply_ignore(findings, opts.ignore);
    return { files: targets.length, lines, findings: [...r.kept, ...r.stale], ignored: r.ignored };
  }
  return { files: targets.length, lines, findings };
}

/**
 * Текст отчёта в формате lint.mjs: «Файлов · Строк», затем ERROR / warn, затем «Итого».
 * @param {{files: number, lines: number, findings: object[], ignored?: object[]}} r результат `lint_project`
 * @param {{show_ignored?: boolean}} [opts] `show_ignored` — перечислить разобранные исключениями предупреждения вместе с причинами
 * @returns {string}
 */
export function format_report(r, opts = {}) {
  const errors = r.findings.filter((f) => f.level === 'error');
  const warns = r.findings.filter((f) => f.level !== 'error');
  const out = [`Файлов: ${r.files} · Строк: ${r.lines}`];
  for (const e of errors) out.push(`ERROR ${e.file}:${e.line}: [${e.rule}] ${e.msg}`);
  for (const w of warns) out.push(`warn  ${w.file}:${w.line}: [${w.rule}] ${w.msg}`);
  const ign = r.ignored ?? [];
  if (opts.show_ignored === true) for (const g of ign) out.push(`skip  ${g.file}:${g.line}: [${g.rule}] ${g.reason}`);
  if (ign.length > 0) out.push(`Разобрано реестром исключений (tools/lint_vocab_ignore.json): ${ign.length}`);
  out.push(`\nИтого: ${errors.length} ошибок, ${warns.length} предупреждений`);
  return out.join('\n') + '\n';
}

// ── запуск из командной строки ──────────────────────────────────────────────────────────────────────────────────────────

/** Сегодняшняя местная календарная дата `ГГГГ-ММ-ДД` по часам машины (FP-50, RISK-22): не UTC-дата — у пояса +14 в первые часы суток UTC ещё вчерашняя. */
function local_today_iso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

async function main(argv) {
  const as_json = argv.includes('--json');
  const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const dirs = argv.flatMap((a, i) => (a === '--dir' ? [argv[i + 1]] : []));
  const today = arg('--today') ?? local_today_iso();
  let registry = null;
  const reg_path = arg('--registry') ?? (existsSync(join(ROOT, 'prototype', 'demo', 'promises.json')) ? join(ROOT, 'prototype', 'demo', 'promises.json') : null);
  if (reg_path !== null) registry = JSON.parse(readFileSync(reg_path, 'utf8'));
  let golden = null;
  try {
    golden = await golden_values();
  } catch (e) {
    console.error('warn  golden-значения недоступны (метки num: не сверены): ' + (e?.code ?? e?.message));
  }
  if (argv.includes('--coverage')) { // перечень чисел G-001 без метки: не линт, ничего не проверяет и не пишет; код выхода 0 (REQ-177)
    if (golden === null) { console.error('ERROR golden-значения недоступны: покрытие не посчитано'); process.exitCode = 1; return; }
    const cov = coverage_project({ golden });
    const lim = Number(arg('--limit'));
    if (as_json) console.log(JSON.stringify({ pages: cov.pages, found: cov.found, labeled: cov.labeled, missing: cov.missing, files: cov.files.filter((f) => f.missing.length > 0) }, null, 2));
    else process.stdout.write(format_coverage(cov, Number.isInteger(lim) && lim > 0 ? { limit: lim } : {}));
    process.exitCode = 0;
    return;
  }
  let catalogs = null;
  try {
    catalogs = [...(await load_catalogs()), ...(await load_template_catalogs())];
  } catch (e) {
    console.error('ERROR каталоги строк интерфейса не загрузились (императивы не проверены): ' + (e?.code ?? e?.message));
    process.exitCode = 1;
  }
  const ignore = argv.includes('--no-ignore') ? [] : load_ignore(arg('--ignore') ?? IGNORE_PATH);
  const r = lint_project({ dirs, today, registry, golden, catalogs, ignore });
  const errors = r.findings.filter((f) => f.level === 'error');
  const warns = r.findings.filter((f) => f.level !== 'error');
  if (as_json) console.log(JSON.stringify({ files: r.files, lines: r.lines, errors, warns, ...(argv.includes('--show-ignored') ? { ignored: r.ignored ?? [] } : {}) }, null, 2));
  else process.stdout.write(format_report(r, { show_ignored: argv.includes('--show-ignored') }));
  process.exitCode = errors.length > 0 || catalogs === null ? 1 : 0; // без process.exit: вывод в конвейер дописывается полностью
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
