// no_default_rates.test.mjs — FP-25, REQ-068 (TST-46, TST-56): в сборке 0 предзаполненных ставок и 0 шаблонов стран.
// Сканер литералов `rate_bp: <число>` (и синонимов) по prototype/{engine,demo,tools} вне data/ и тестов: комментарии не в счёт, ноль — «ставки нет» (рассрочка без процентов).
// Данные: ставки в prototype/data/**/*.json разрешены ТОЛЬКО по явному списку исключений с причиной (демо-правило 20 % в наборах G-001 — канон, не меняется).
// Шаблоны (data/templates, demo/start_template.mjs, шаблоны ответов верификатора, каталоги строк, профили импорта): rate_bp = null, названий стран и налоговых режимов нет.
// Ответы ассистента A0 (T0): «ставка N %» называется только если N есть в ws.tax_rules; на рабочей области без правил — не называется вовсе.
// Юридическое ревью формулировок (REQ-183) остаётся за людьми (FP-27). В тестах допустимы node:*.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const RUNWAY = path.resolve(PROTO, '..');
const imp = (...p) => import(pathToFileURL(path.join(...p)).href);

const LINT = await imp(RUNWAY, 'tools', 'lint_vocab.mjs');
const APP = await imp(PROTO, 'demo', 'app.mjs');
const I18N = await imp(PROTO, 'demo', 'i18n.mjs');
const { TEMPLATES } = await imp(PROTO, 'demo', 'start_template.mjs');
const { templates } = await imp(PROTO, 'engine', 'verifier.mjs');
const read_json = (...p) => JSON.parse(fs.readFileSync(path.join(PROTO, ...p), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── сканер литералов ставок ──────────────────────────────────────────────────────────────────────────────────────────────

/** Имена полей ставки: `rate_bp` и синонимы, под которые легко спрятать значение по умолчанию. */
const RATE_KEYS = ['rate_bp', 'rate_pct', 'tax_rate', 'vat_rate'];
const KEY = '(?<![\\w$])["\']?(?:' + RATE_KEYS.join('|') + ')["\']?';
/** `rate_bp: 2000`, `rate_bp = 1200`, `"rate_bp": 2000`, `rate_bp ?? 2000`, `rate_bp || 1500`: числовой литерал после ключа. */
const LITERAL_RE = new RegExp(KEY + '\\s*(?:[:=]|\\?\\?|\\|\\|)\\s*([-+]?\\d[\\d_]*(?:\\.\\d+)?)', 'g');

/**
 * Литералы ставок в тексте исходника. Комментарии JS отброшены (документация не значение); нулевой литерал — не ставка (`rate_bp = 0`: рассрочка без процентов).
 * @param {string} src
 * @param {string} file
 * @returns {{file: string, line: number, key: string, value: number}[]}
 */
export function find_rate_literals(src, file = '<src>') {
  const body = /\.m?js$/i.test(file) ? LINT.strip_js_comments(src) : src;
  const out = [];
  for (const m of body.matchAll(LITERAL_RE)) {
    const value = Number(m[1].replaceAll('_', ''));
    if (value === 0) continue;
    const line = body.slice(0, m.index).split('\n').length;
    out.push({ file, line, key: RATE_KEYS.find((k) => m[0].includes(k)), value });
  }
  return out;
}

const SCAN_EXT = new Set(['.mjs', '.js', '.json', '.html', '.webmanifest']);
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (SCAN_EXT.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

/** Явный список исключений для КОДА (engine, demo, tools): пуст — в коде нет ни одного значения ставки по умолчанию. */
const CODE_EXCEPTIONS = Object.freeze([]);

/**
 * Явный список исключений для ДАННЫХ prototype/data/**\/*.json: файл, путь, значение, причина. Всё, чего нет в списке, — нарушение;
 * записи списка, которых в данных нет, — устаревшая запись (тоже нарушение).
 */
const DATA_EXCEPTIONS = Object.freeze([
  ...['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json', 'g001-debt.json'].map((f) => ({
    file: 'data/' + f, path: 'tax_rules[0].rate_bp', value: 2000,
    reason: 'демо-правило 20 % «правило пользователя» из сквозного примера G-001 (design-brief §9): канон, числа G-001 не меняются; это введённые данные набора, а не значение по умолчанию приложения',
  })),
  {
    file: 'data/g001-debt.json', path: 'debts[0].rate_bp', value: 1200,
    reason: 'ставка по кредиту D-LOAN в тест-наборе долга (проценты по долгу, не налоговая ставка); набор g001-debt в выбор наборов демо не входит',
  },
]);

/** Числовые ненулевые `rate_bp` в разобранном JSON с путём вида `tax_rules[0].rate_bp`. */
function json_rates(node, at = '', out = []) {
  if (Array.isArray(node)) node.forEach((x, i) => json_rates(x, `${at}[${i}]`, out));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = at === '' ? k : `${at}.${k}`;
      if (RATE_KEYS.includes(k) && typeof v === 'number' && v !== 0) out.push({ path: p, value: v });
      else json_rates(v, p, out);
    }
  }
  return out;
}

test('REQ-068 сканер литералов ставок: находит rate_bp: N в коде и JSON, не считает комментарии, ноль, null и обращения к полю', () => {
  const hit = (src, file = 'x.mjs') => find_rate_literals(src, file).map((f) => [f.key, f.value]);
  assert.deepEqual(hit('const r = { rate_bp: 2000 };'), [['rate_bp', 2000]]);
  assert.deepEqual(hit('{ "rate_bp": 1200, "n": 6 }', 'x.json'), [['rate_bp', 1200]]);
  assert.deepEqual(hit('let rate_bp = 1_500;'), [['rate_bp', 1500]]);
  assert.deepEqual(hit('const v = rule.rate_bp ?? 2000;'), [['rate_bp', 2000]]);
  assert.deepEqual(hit('const v = rate_bp || 1000;'), [['rate_bp', 1000]]);
  assert.deepEqual(hit('const tax_rate = 0.2;'), [['tax_rate', 0.2]]);
  assert.deepEqual(hit('const vat_rate: 21'), [['vat_rate', 21]]);
  // не находит
  assert.deepEqual(hit('// rate_bp: 2000 — пример в комментарии\n/* rate_bp = 1200 */ const x = 1;'), [], 'комментарии');
  assert.deepEqual(hit('function f({ n, rate_bp = 0 }) { return rate_bp; }'), [], 'ноль — ставки нет');
  assert.deepEqual(hit('{ "rate_bp": null }', 'x.json'), [], 'null — ставки нет');
  assert.deepEqual(hit('const r = rule.rate_bp; check(rate_bp, 2000); const xrate_bp = 5;'), [], 'обращение к полю и чужие имена');
  assert.deepEqual(hit('const s = "ставка rate_bp вводится пользователем";'), []);
  assert.equal(find_rate_literals('a\nb\nconst r = { rate_bp: 7 };', 'x.mjs')[0].line, 3, 'номер строки');
});

test('REQ-068 в prototype/{engine,demo,tools} (вне data/ и тестов) нет литералов ставок по умолчанию; список исключений для кода пуст', () => {
  const files = ['engine', 'demo', 'tools'].flatMap((d) => walk(path.join(PROTO, d)));
  files.push(...['cli.mjs', 'serve.mjs'].map((f) => path.join(PROTO, f)));
  assert.ok(files.length > 150, `просканировано файлов: ${files.length}`);
  assert.ok(files.some((f) => f.endsWith(path.join('engine', 'tax.mjs'))) && files.some((f) => f.endsWith(path.join('demo', 'i18n', 'forms.mjs'))), 'нужные каталоги прочитаны');
  const found = [];
  for (const f of files) {
    const rel = path.relative(PROTO, f).split(path.sep).join('/');
    for (const x of find_rate_literals(fs.readFileSync(f, 'utf8'), rel)) {
      if (!CODE_EXCEPTIONS.some((e) => e.file === x.file && e.line === x.line)) found.push(`${x.file}:${x.line} ${x.key} = ${x.value}`);
    }
  }
  assert.deepEqual(found, [], 'литералы ставок в коде');
  assert.deepEqual([...CODE_EXCEPTIONS], [], 'для кода исключений нет');
  // сканер действительно ловит нарушение в реальном файле: подмена исходника engine/tax.mjs
  const tax = fs.readFileSync(path.join(PROTO, 'engine', 'tax.mjs'), 'utf8');
  assert.equal(find_rate_literals(tax, 'engine/tax.mjs').length, 0);
  assert.equal(find_rate_literals(tax + '\nexport const DEFAULT_TAX = { rate_bp: 2000 };\n', 'engine/tax.mjs').length, 1, 'намеренная вставка ставки ловится');
});

test('REQ-068 данные prototype/data: ставки есть только по явному списку исключений с причиной (демо-правило 20 % в G-001 — канон); ни одной лишней и ни одной устаревшей записи', () => {
  const data_dir = path.join(PROTO, 'data');
  const files = walk(data_dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 10, `JSON в data: ${files.length}`);
  const actual = [];
  for (const f of files) {
    const rel = 'data/' + path.relative(data_dir, f).split(path.sep).join('/');
    for (const r of json_rates(JSON.parse(fs.readFileSync(f, 'utf8')))) actual.push({ file: rel, ...r });
  }
  const key = (x) => `${x.file} ${x.path} ${x.value}`;
  assert.deepEqual(actual.map(key).sort(), DATA_EXCEPTIONS.map(key).sort(), 'ставки в данных = список исключений');
  for (const e of DATA_EXCEPTIONS) assert.ok(e.reason.length >= 40, `${e.file}: причина исключения записана`);
  // канон G-001 не тронут: демо-правило остаётся 20 % и помечено «правилом пользователя»
  const g = read_json('data', 'g001.json');
  assert.equal(g.tax_rules[0].rate_bp, 2000);
  assert.match(g.tax_rules[0].name, /правило пользователя/i);
});

/** Проверка пути вида `tax_rules[0].rate_bp` в разобранном JSON (чтобы список исключений ссылался на настоящие места). */
function at_path(root, p) {
  return p.split(/\.|(?=\[)/).filter(Boolean).reduce((n, k) => n?.[k.startsWith('[') ? Number(k.slice(1, -1)) : k], root);
}

test('REQ-068 пути списка исключений указывают на настоящие значения', () => {
  for (const e of DATA_EXCEPTIONS) assert.equal(at_path(read_json(...e.file.split('/')), e.path), e.value, `${e.file} ${e.path}`);
});

// ── шаблоны: нет ставок, стран и налоговых режимов ───────────────────────────────────────────────────────────────────────

/** Названия стран (RU — с падежными формами, регистр важен; EN) и налоговых режимов: в шаблонах и подсказках их быть не должно. */
const COUNTRY_RU = ['Росси(?:я|и|ю|ей)', 'Германи(?:я|и|ю|ей)', 'Испани(?:я|и|ю|ей)', 'Франци(?:я|и|ю|ей)', 'Итали(?:я|и|ю|ей)', 'США', 'Великобритани(?:я|и|ю|ей)', 'Англи(?:я|и|ю|ей)',
  'Украин(?:а|ы|е|у|ой)', 'Беларус(?:ь|и)', 'Казахстан(?:а|е|у|ом)?', 'Польш(?:а|и|е|у|ей)', 'Португали(?:я|и|ю|ей)', 'Нидерланд(?:ы|ов|ах)', 'Турци(?:я|и|ю|ей)', 'Кипр(?:а|е|у|ом)?',
  'Швейцари(?:я|и|ю|ей)', 'Австри(?:я|и|ю|ей)', 'Финлянди(?:я|и|ю|ей)', 'Швеци(?:я|и|ю|ей)', 'Норвеги(?:я|и|ю|ей)', 'Дани(?:я|и|ю|ей)', 'Литв(?:а|ы|е|у|ой)', 'Латви(?:я|и|ю|ей)',
  'Эстони(?:я|и|ю|ей)', 'Армени(?:я|и|ю|ей)', 'Азербайджан(?:а|е|у|ом)?', 'Молдов(?:а|ы|е|у|ой)', 'Узбекистан(?:а|е|у|ом)?', 'Китай|Китае|Китая', 'Япони(?:я|и|ю|ей)', 'Канад(?:а|ы|е|у|ой)',
  'Австрали(?:я|и|ю|ей)', 'Израил(?:ь|я|е|ю)', 'ОАЭ', 'Грузи(?:я|и|ю|ей)', 'Чехи(?:я|и|ю|ей)'];
const COUNTRY_EN = ['Russia', 'Germany', 'Spain', 'France', 'Italy', 'USA', 'U\\.S\\.A?\\.?', 'United States', 'United Kingdom', 'UK', 'Britain', 'England', 'Ukraine', 'Belarus', 'Kazakhstan', 'Poland',
  'Portugal', 'Netherlands', 'Turkey', 'Cyprus', 'Switzerland', 'Austria', 'Finland', 'Sweden', 'Norway', 'Denmark', 'Lithuania', 'Latvia', 'Estonia', 'Armenia', 'Azerbaijan', 'Moldova',
  'Uzbekistan', 'China', 'Japan', 'Canada', 'Australia', 'Israel', 'UAE', 'Czechia', 'Georgia'];
const REGIMES = ['IVA', 'IRPF', 'НДС', 'НДФЛ', 'УСН', 'ЕНВД', 'VAT', 'GST', 'IRS', 'HMRC', 'Steuer', 'Umsatzsteuer', 'Kleinunternehmer', 'Gewerbe', 'W-2', '1099', 'самозанят\\p{L}*', 'Самозанят\\p{L}*'];
const NAMES_RE = new RegExp('(?<![\\p{L}\\d])(?:' + [...COUNTRY_RU, ...COUNTRY_EN, ...REGIMES].join('|') + ')(?![\\p{L}\\d])', 'u');

/** Все строки значений вложенного объекта/массива. */
function strings_of(x, out = []) {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => strings_of(v, out));
  else if (x !== null && typeof x === 'object') Object.values(x).forEach((v) => strings_of(v, out));
  return out;
}

test('REQ-068 названия стран и налоговых режимов: сканер находит примеры, а в шаблонах, каталогах строк, шаблонах ответов и профилях их нет', async () => {
  for (const s of ['Налог в Германии', 'Tax rules for Spain', 'ставка IVA', 'ставка НДС 20 %', 'Kleinunternehmer', 'самозанятый', 'US tax in the USA']) assert.match(s, NAMES_RE, s);
  for (const s of ['Налоговый конверт', 'Russian layout', 'правило пользователя', 'Georgian', 'Спирит']) assert.doesNotMatch(s, NAMES_RE, s);
  const cats = await LINT.load_catalogs();
  const corpus = [
    ['каталоги строк интерфейса', cats.flatMap((c) => [...strings_of(c.ru), ...strings_of(c.en)])],
    ['demo/i18n.mjs подписи данных', strings_of(I18N.DATA_LABELS)],
    ['шаблоны-скелеты demo/start_template.mjs', strings_of(TEMPLATES)],
    ['шаблоны ответов верификатора RU', strings_of(templates('ru'))],
    ['шаблоны ответов верификатора EN', strings_of(templates('en'))],
    ['data/templates/*.json', fs.readdirSync(path.join(PROTO, 'data', 'templates')).flatMap((n) => strings_of(read_json('data', 'templates', n)))],
    ['data/profiles/*.json', fs.readdirSync(path.join(PROTO, 'data', 'profiles')).flatMap((n) => strings_of(read_json('data', 'profiles', n)))],
  ];
  let checked = 0;
  for (const [what, list] of corpus) {
    assert.ok(list.length > 5, `${what}: строки прочитаны`);
    for (const s of list) {
      checked++;
      assert.doesNotMatch(s, NAMES_RE, `${what}: «${s.slice(0, 80)}»`);
    }
  }
  assert.ok(checked > 5000, `проверено строк: ${checked}`);
});

test('REQ-068 шаблоны (JSON и зеркало в коде): rate_bp = null, срок годности правила есть, суммы не заполнены, политика no_prefilled_amounts_or_rates', () => {
  for (const name of fs.readdirSync(path.join(PROTO, 'data', 'templates'))) {
    const tpl = read_json('data', 'templates', name);
    assert.deepEqual(json_rates(tpl), [], `${name}: ненулевых ставок нет`);
    assert.equal(tpl.tax_rule.rate_bp, null, `${name}: ставка не задана`);
    assert.equal(tpl.policy, 'no_prefilled_amounts_or_rates');
    assert.deepEqual(tpl, JSON.parse(JSON.stringify(TEMPLATES[tpl.template_id])), `${name}: зеркало в коде равно файлу`);
  }
  assert.ok(Object.keys(TEMPLATES).length >= 1);
});

// ── ответы ассистента A0 (T0): «ставки N %» только из ws.tax_rules ───────────────────────────────────────────────────────

const QUESTIONS = {
  ru: ['можно ли купить за 300 € 12 октября', 'сколько можно потратить 12 октября', 'когда можно купить за 300 €', 'почему узкая точка', 'какие волны платежей', 'налоговый конверт', 'если клиент заплатит на 10 дней позже'],
  en: ['can I buy for €300 on October 12', 'how much can I spend on October 12', 'when can I buy for €300', 'why the narrowest point', 'which payment waves', 'tax envelope', 'if the client pays 10 days later'],
};
const RATE_STATEMENT = /(?:ставк\p{L}*|rate)\D{0,24}?(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%\s*(?:ставк|rate|налог|tax)/giu;

/** Проценты, названные ответом как ставка, и разрешённые источники: rate_bp правил ws.tax_rules (как «20», «20,5», «20.5»). */
function stated_rates(text) {
  return [...text.matchAll(RATE_STATEMENT)].map((m) => (m[1] ?? m[2]).replace(',', '.'));
}
function allowed_rates(ws) {
  const out = new Set();
  for (const r of (ws.tax_rules ?? []).flat()) out.add(String(r.rate_bp / 100));
  return out;
}

test('REQ-068 TST-46 ответы A0 (T0): «ставка N %» не называется без источника в ws.tax_rules — на рабочей области без правил ставок в ответах нет, на G-001 названа только ставка правила пользователя', () => {
  const rate_samples = ['ставка 20 %', 'rate of 20 %', '20 % налог', 'rate 7.5%'];
  for (const s of rate_samples) assert.ok(stated_rates(s).length > 0, `детектор видит «${s}»`);
  assert.deepEqual(stated_rates('покрытие волны 154,3 %, минимум 205 500'), [], 'покрытие волны — не ставка');
  const G = read_json('data', 'g001.json');
  const bare = { ...clone(G), tax_rules: [], reserves: [], allocations: [] };
  let answers = 0;
  for (const [ws, with_rules] of [[bare, false], [G, true]]) {
    const m = APP.build_model(ws);
    const ref = APP.first_income_ref(m);
    const allowed = allowed_rates(ws);
    assert.equal(allowed.size > 0, with_rules);
    for (const lang of ['ru', 'en']) {
      for (const q of QUESTIONS[lang]) {
        const r = APP.ask_a0(m, q, lang, ref);
        if (!r.ok) continue; // вопрос без ответа (нет данных) ставок не называет
        answers++;
        for (const rate of stated_rates(r.text)) assert.ok(allowed.has(String(Number(rate))), `${lang} «${q}»: ставка ${rate} % не из ws.tax_rules: ${r.text}`);
        if (!with_rules) assert.deepEqual(stated_rates(r.text), [], `${lang} «${q}»: без правил ставок нет`);
      }
    }
  }
  assert.ok(answers >= 20, `ответов проверено: ${answers}`);
  // налоговые числа несут оговорку «расчёт по введённым правилам, не консультация»
  const m = APP.build_model(G);
  const tax = APP.ask_a0(m, 'налоговый конверт', 'ru', APP.first_income_ref(m));
  assert.ok(tax.text.includes('не консультация'));
});
