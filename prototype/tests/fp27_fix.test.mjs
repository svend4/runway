// fp27_fix.test.mjs — проход исправлений FP-27 после независимой проверки: по тесту на каждый дефект (high и medium обязательно, low — где возможно).
// Дефект 1 (high, REQ-183): пакет для юриста пропускал строки налогового конверта и правил — выборка шла только по слову «налог/tax» в тексте. Теперь класс «налоги» подтверждается
//   ещё и ключом строки (куски `tax…`/`envelope…`, экраны `rs.*` и `reserveui.*`) и словами «конверт/envelope»; полнота проверяется ПО КЛЮЧАМ и по другим словам, а не повтором регэкспа сборщика.
// Дефект 2 (medium, REQ-110/REQ-178): дата замера без --today не сверялась: измерение «из будущего» обходило срок годности 90 дней. Теперь запись требует известной сегодняшней даты
//   (--today или часы настоящего запуска) и отвергает будущую и устаревшую дату.
// Дефект 3 (medium, REQ-110/REQ-189): медиана «до первого прогноза» считалась только по дошедшим, а текст и запись реестра этого не называли (смещение выжившего). Теперь рядом с n стоит
//   число начавших (`started`), ниже 80 % дошедших — предупреждение, ниже 50 % — отказ.
// Дефекты 4–5, 7 (low): копия листа наблюдателя с другим порядком ключей; люди с неполным набором попыток; описание «активного времени» (паузы урезаются до 60 с, а не исключаются);
//   оговорка о неполных выгрузках CSV и hledger на странице плана «если разработчик исчез».
// Настоящие demo/promises.json и _ops/people тесты НЕ меняют: реестр — в памяти или копией во временной папке, пакет только читается.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const RUNWAY = path.join(PROTO, '..');
const imp = (...p) => import(pathToFileURL(path.join(...p)).href);

const PP = await imp(PROTO, 'tools', 'people_pack.mjs');
const OM = await imp(PROTO, 'tools', 'onboarding_median.mjs');
const MX = await imp(PROTO, 'demo', 'metrics.mjs');
const WZ = await imp(PROTO, 'demo', 'wizard.mjs');
const LINT = await imp(RUNWAY, 'tools', 'lint_vocab.mjs');
const DATA = await PP.collect_legal_data();
const PACK = fs.readFileSync(path.join(RUNWAY, '_ops', 'people', 'legal-review-package.md'), 'utf8').replace(/\r\n/g, '\n');
const PROTOCOL = fs.readFileSync(path.join(RUNWAY, '_ops', 'people', 'timing-protocol.md'), 'utf8');
const PAGE = fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '20-if-developer-disappears.md'), 'utf8');
const REAL_REGISTRY_TEXT = fs.readFileSync(path.join(PROTO, 'demo', 'promises.json'), 'utf8');
const VOCAB = LINT.load_vocab();
const display_file = (f) => f.replace(/^prototype\//, '').replace(/^demo\//, '');
const row_needle = (file, key) => '| `' + display_file(file) + '` · `' + key + '` |';

// ── общие помощники ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Файл метрик настоящим `create_metrics`: два шага мастера общей длиной `total` секунд; `forecast = false` — человек до прогноза не дошёл. */
function metrics_file(total, forecast = true) {
  const m = MX.create_metrics({ storage: null, day: () => 20000, engine_version: '0.1.0' });
  m.begin_session();
  m.record_step({ step: 'account', seconds: Math.floor(total / 2), outcome: 'saved' });
  m.record_step({ step: 'obligations', seconds: total - Math.floor(total / 2), outcome: 'saved' });
  if (forecast) m.mark_first_forecast();
  return m.package_text();
}

/** Ввод-вывод в памяти; `clock` — сегодняшняя дата «часов» настоящего запуска (null — часов нет, как у голого порта). */
function fake_io(files, clock = null) {
  const outs = [];
  const errs = [];
  const writes = [];
  const io = {
    read: (p) => { if (!Object.hasOwn(files, p)) throw Object.assign(new Error('нет файла'), { code: 'ENOENT' }); return files[p]; },
    write: (p, t) => { writes.push([p, t]); files[p] = t; },
    out: (s) => outs.push(s),
    err: (s) => errs.push(s),
    outs, errs, writes,
  };
  if (clock !== null) io.today = () => clock;
  return io;
}
const REG = path.resolve('fix-registry.json');

/** `reached` дошедших до прогноза и `lost` не дошедших: файлы и их имена. */
function cohort_files(reached, lost) {
  const files = { [REG]: REAL_REGISTRY_TEXT };
  const names = [];
  for (let i = 0; i < reached; i++) { files['r' + i] = metrics_file(100 + 10 * i); names.push('r' + i); }
  for (let i = 0; i < lost; i++) { files['x' + i] = metrics_file(30 + i, false); names.push('x' + i); }
  return { files, names };
}

const sheet = (persons, extra = {}) => JSON.stringify({ format: OM.TIMING_FORMAT, measure: 'quick_entry', persons, ...extra });

// ── дефект 1 (high): пакет для юриста и налоговый конверт ────────────────────────────────────────────────────────────────

test('REQ-183 FIX-1 tax_key: куски ключа tax…/envelope… и экраны rs.*, reserveui.* — налоговый конверт; ставки долгов и курсы валют — нет', () => {
  for (const key of ['rs.tax_line', 'rs.title', 'forms.tax_none', 'forms.h_tax_rate', 'forms.f_rate_tax', 'forms.f_tax_rule_id', 'freelancer-skeleton.tax_rule.note', 'reserveui.rules_lead', 'reserveui.close', 'x.envelope_note', 'c.tax_note']) {
    assert.equal(PP.tax_key(key), true, key);
  }
  for (const key of ['debtedit.sum_rate', 'forms.f_rate_fx', 'forms.f_rate_inst', 'ratechip.err_no_rate', 'forms.hours_rate', 'v0.f_rate', 'entry.guard_note', '', undefined]) {
    assert.equal(PP.tax_key(key), false, String(key));
  }
});

test('REQ-183 FIX-1 classify по ключу и по словам «конверт/envelope»: строка без слова «налог» в налоговом конверте попадает в класс; без ключа и без слов — нет', () => {
  assert.deepEqual(PP.classify('Правило «{name}» записано.', 'Rule “{name}” saved.'), []);
  assert.deepEqual(PP.classify('Правило «{name}» записано.', 'Rule “{name}” saved.', 'forms.tax_saved'), ['tax']);
  assert.deepEqual(PP.classify('Ставку введите сами: приложение ставок не подсказывает', 'Enter the rate yourself', 'forms.tax_none'), ['tax']);
  assert.deepEqual(PP.classify('Записать в конверт ({sum})', 'Write to the envelope ({sum})', 'forms.pend_write'), ['tax']);
  assert.deepEqual(PP.classify('', 'Move it to the envelope'), ['tax']);
  assert.deepEqual(PP.classify('Резервы', 'Reserves', 'rs.title'), ['tax']);
  assert.deepEqual(PP.classify('Ставка', 'Rate', 'debtedit.sum_rate'), [], 'ставка по долгу — не налог');
  assert.deepEqual(PP.classify('Курс', 'Rate', 'forms.f_rate_fx'), []);
  // прежняя сигнатура (без ключа) работает как раньше
  assert.deepEqual(PP.classify('Налоговый конверт', 'Tax envelope'), ['tax']);
  assert.deepEqual(PP.classify('Сохранить', 'Save', 'a.plain'), []);
});

test('REQ-183 FIX-1 полнота ПО КЛЮЧАМ (не повтор регэкспа сборщика): каждая строка каталогов с ключом tax…, каждая строка экранов rs.* и reserveui.* и каждая со словом «конверт/envelope» есть в пакете', () => {
  const by_key = /(^|[._])tax|^(?:rs|reserveui)\./i;
  const by_word = /конверт|envelope/i;
  let checked_key = 0;
  let checked_word = 0;
  const missing = [];
  for (const cat of DATA.catalogs) {
    for (const key of Object.keys(cat.ru)) {
      const text = cat.ru[key] + '\n' + (cat.en?.[key] ?? '');
      const hit_key = by_key.test(key);
      const hit_word = by_word.test(text);
      if (!hit_key && !hit_word) continue;
      if (hit_key) checked_key++;
      if (hit_word) checked_word++;
      if (!PACK.includes(row_needle(cat.file, key))) missing.push(display_file(cat.file) + ' · ' + key);
    }
  }
  assert.deepEqual(missing, [], 'не попали в пакет (' + missing.length + '): ' + missing.slice(0, 6).join(', '));
  assert.ok(checked_key > 100, 'проверено строк по ключу: ' + checked_key);
  assert.ok(checked_word > 20, 'проверено строк по словам: ' + checked_word);
});

test('REQ-183 FIX-1 именные строки, ради которых задан вопрос Q1, и строки из отчёта проверки — в пакете (rs.tax_line, forms.tax_none, forms.h_tax_*, forms.f_rate_tax, шаблон-скелет, reserveui.*)', () => {
  const must = [
    ['prototype/demo/i18n.mjs', 'rs.tax_line'], ['prototype/demo/i18n.mjs', 'rs.tax_release'], ['prototype/demo/i18n.mjs', 'rs.tax_none'], ['prototype/demo/i18n.mjs', 'rs.tax_masked'],
    ['prototype/demo/i18n/forms.mjs', 'forms.tax_none'], ['prototype/demo/i18n/forms.mjs', 'forms.tax_stale_text'], ['prototype/demo/i18n/forms.mjs', 'forms.tax_preview_row'],
    ['prototype/demo/i18n/forms.mjs', 'forms.h_tax_rate'], ['prototype/demo/i18n/forms.mjs', 'forms.f_rate_tax'], ['prototype/demo/i18n/forms.mjs', 'forms.f_tax_rule_id'],
    ['prototype/demo/i18n/forms.mjs', 'forms.th_hidden'], ['prototype/demo/i18n/forms.mjs', 'forms.pend_write'],
    ['prototype/demo/i18n/reserveui.mjs', 'reserveui.rules_lead'], ['prototype/demo/i18n/reserveui.mjs', 'reserveui.release_note'],
    ['prototype/demo/start_template.mjs', 'freelancer-skeleton.tax_rule.note'],
  ];
  for (const [file, key] of must) {
    assert.ok(DATA.catalogs.some((c) => c.file === file && typeof c.ru[key] === 'string'), 'строка есть в каталоге: ' + key);
    assert.ok(PACK.includes(row_needle(file, key)), 'нет в пакете: ' + key);
  }
  assert.ok(PACK.includes('`rs.tax_line`') && PACK.includes('`forms.tax_none`'));
});

test('REQ-183 FIX-1 пакет честно называет метод выборки по ключу и сохраняет прежние оговорки (по ключевым словам с запасом; Q1; пересборка)', () => {
  assert.match(PACK, /Выборка по ключевым словам с запасом/);
  assert.match(PACK, /ещё строки по ключу/);
  assert.ok(PACK.includes('`rs.*`') && PACK.includes('`reserveui.*`') && PACK.includes('`rs.tax_line`'));
  assert.match(PACK, /«конверт», tax, envelope/);
  assert.match(PACK, /\| Q1 \| Считается ли показ суммы «в конверт по правилу пользователя»/);
  const header_count = /Строк в выборке \(§3\) \| (\d+) \(налоги — (\d+)/.exec(PACK);
  assert.ok(header_count !== null && Number(header_count[1]) > 250 && Number(header_count[2]) > 150, 'выборка выросла: ' + (header_count?.[0] ?? '—'));
  // настоящая выгрузка равна коду (после правки выборки пакет пересобран)
  assert.equal(PACK, PP.build_legal_package(DATA));
});

// ── дефект 2 (medium): дата замера сверяется с сегодняшней ───────────────────────────────────────────────────────────────

test('REQ-110 REQ-178 FIX-2 без --today и без часов запись не выполняется (и при просмотре с --date): код 1, реестр не тронут, причина и флаг --today названы', () => {
  const { files, names } = cohort_files(5, 0);
  for (const extra of [['--date', '2026-11-02', '--write'], ['--date', '2099-01-01', '--write'], ['--date', '2026-11-02']]) {
    const io = fake_io({ ...files });
    const code = OM.main([...names, '--registry', REG, ...extra], io);
    assert.equal(code, 1, extra.join(' '));
    assert.equal(io.writes.length, 0);
    const out = io.outs.join('\n');
    assert.match(out, /Отказ: не известна сегодняшняя дата/);
    assert.match(out, /--today ГГГГ-ММ-ДД/);
    assert.doesNotMatch(out, /Записано в/);
  }
});

test('REQ-110 REQ-178 FIX-2 с часами запуска: дата из будущего и устаревшая отвергаются без --today; нормальная пишется; --today сильнее часов; часы вернули не дату — как неизвестные', () => {
  const { files, names } = cohort_files(5, 0);
  const run = (extra, clock = '2026-12-31') => {
    const io = fake_io({ ...files }, clock);
    return { code: OM.main([...names, '--registry', REG, ...extra], io), io };
  };
  const future = run(['--date', '2099-01-01', '--write']);
  assert.equal(future.code, 1);
  assert.match(future.io.outs.join('\n'), /дата замера 2099-01-01 позже сегодняшней 2026-12-31/);
  assert.equal(future.io.writes.length, 0);
  const typo_year = run(['--date', '2027-10-23', '--write'], '2026-10-24');
  assert.equal(typo_year.code, 1, 'опечатка в годе (2027 вместо 2026)');
  assert.match(typo_year.io.outs.join('\n'), /позже сегодняшней 2026-10-24/);
  const stale = run(['--date', '2026-01-10', '--write']);
  assert.equal(stale.code, 1);
  assert.match(stale.io.outs.join('\n'), /старше 90 дней/);
  const good = run(['--date', '2026-12-01', '--write']);
  assert.equal(good.code, 0, good.io.outs.join('\n'));
  assert.equal(JSON.parse(good.io.writes[0][1]).at(-1).measured_on, '2026-12-01');
  // --today сильнее часов: часы говорят 12-31, человек сказал 12-01 — дата 12-31 уже «из будущего»
  const flag_wins = run(['--date', '2026-12-31', '--today', '2026-12-01', '--write']);
  assert.equal(flag_wins.code, 1);
  assert.match(flag_wins.io.outs.join('\n'), /позже сегодняшней 2026-12-01/);
  // без часов, но с --today — запись возможна
  const io = fake_io({ ...files });
  assert.equal(OM.main([...names, '--registry', REG, '--date', '2026-11-02', '--today', '2026-11-02', '--write'], io), 0);
  // часы вернули не дату
  for (const bad of ['вчера', '2026-02-30', '']) {
    const r = run(['--date', '2026-11-02', '--write'], bad);
    assert.equal(r.code, 1, 'часы: «' + bad + '»');
    assert.match(r.io.outs.join('\n'), /не известна сегодняшняя дата/);
  }
});

test('REQ-110 REQ-178 FIX-2 процесс: настоящие часы без --today — дата 2099-01-01 отвергается (код 1, копия реестра не тронута), вчерашняя пишется; настоящий demo/promises.json не меняется', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-om-fix-'));
  const real_before = fs.readFileSync(path.join(PROTO, 'demo', 'promises.json'), 'utf8');
  try {
    const reg = path.join(dir, 'promises.json');
    fs.writeFileSync(reg, REAL_REGISTRY_TEXT, 'utf8');
    const files = [300, 360, 420, 480, 540].map((t, i) => { const f = path.join(dir, `P0${i + 1}.json`); fs.writeFileSync(f, metrics_file(t), 'utf8'); return f; });
    const run = (extra) => spawnSync(process.execPath, [path.join(PROTO, 'tools', 'onboarding_median.mjs'), ...files, '--registry', reg, ...extra], { encoding: 'utf8', timeout: 100000 });
    const future = run(['--date', '2099-01-01', '--write']);
    assert.equal(future.status, 1, future.stdout + future.stderr);
    assert.match(future.stdout, /позже сегодняшней/);
    assert.equal(fs.readFileSync(reg, 'utf8'), REAL_REGISTRY_TEXT);
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterday = String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const done = run(['--date', yesterday, '--write']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    const rec = JSON.parse(fs.readFileSync(reg, 'utf8')).at(-1);
    assert.deepEqual([rec.id, rec.level, rec.n, rec.started, rec.measured_on], ['first_forecast_time', 'measured', 5, 5, yesterday]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(path.join(PROTO, 'demo', 'promises.json'), 'utf8'), real_before, 'настоящий реестр не тронут');
});

// ── дефект 3 (medium): смещение выжившего ─────────────────────────────────────────────────────────────────────────────────

test('REQ-110 FIX-3 reach_check: целочисленные пороги 80 % (предупреждение) и 50 % (отказ); неверные числа — RangeError', () => {
  assert.deepEqual(OM.reach_check(10, 10), { started: 10, reached: 10, refuse: false, warn: false });
  assert.equal(OM.reach_check(10, 8).warn, false, 'ровно 80 % — без предупреждения');
  assert.equal(OM.reach_check(10, 7).warn, true);
  assert.equal(OM.reach_check(10, 5).refuse, false, 'ровно 50 % — не отказ');
  assert.equal(OM.reach_check(10, 5).warn, true);
  assert.equal(OM.reach_check(11, 5).refuse, true);
  assert.equal(OM.reach_check(0, 0).refuse, false);
  assert.throws(() => OM.reach_check(4, 5), RangeError);
  assert.throws(() => OM.reach_check(1.5, 1), RangeError);
  assert.throws(() => OM.reach_check(5, -1), RangeError);
  assert.equal(OM.REACH_MIN_PCT, 50);
  assert.equal(OM.REACH_WARN_PCT, 80);
});

test('REQ-110 FIX-3 читатель метрик считает начавших: дошедшие, не получившие прогноз и без шагов мастера — начали; копии и неверные файлы — нет', () => {
  const m = MX.create_metrics({ storage: null, day: () => 20000, engine_version: '0.1.0' });
  m.begin_session();
  m.mark_first_forecast(); // прогноз без шагов мастера: время неизвестно
  const no_steps = m.package_text();
  const inputs = [
    { name: 'a', text: metrics_file(100) }, { name: 'b', text: metrics_file(110) }, { name: 'copy_of_a', text: metrics_file(100) },
    { name: 'lost', text: metrics_file(40, false) }, { name: 'no_steps', text: no_steps }, { name: 'junk', text: '{' },
  ];
  const r = OM.read_metrics_values(inputs);
  assert.deepEqual(r.used.map((u) => u.name), ['a', 'b']);
  assert.equal(r.started, 4, 'a, b, lost, no_steps');
  assert.deepEqual(r.skipped.map((s) => [s.name, s.reason]), [['copy_of_a', 'duplicate'], ['lost', 'first_forecast_not_reached'], ['no_steps', 'no_wizard_steps'], ['junk', 'not_json']]);
});

test('REQ-110 FIX-3 командная строка: 5 из 10 — запись есть, предупреждение, «n из начавших» в отчёте, в записи реестра (started) и в предложенных текстах RU и EN', () => {
  const { files, names } = cohort_files(5, 5);
  const io = fake_io(files, '2026-10-23');
  const code = OM.main([...names, '--date', '2026-10-23', '--registry', REG, '--write'], io);
  assert.equal(code, 0, io.outs.join('\n'));
  const out = io.outs.join('\n');
  assert.match(out, /начали: 10 · учтено людей \(n\): 5/);
  assert.match(out, /Дошли до результата: 5 из 10/);
  assert.match(out, /Предупреждение: дошли меньше 80 % начавших/);
  const rec = JSON.parse(files[REG]).at(-1);
  assert.deepEqual([rec.id, rec.level, rec.n, rec.started], ['first_forecast_time', 'measured', 5, 10]);
  const ru = /ru: (.*)/.exec(out)[1];
  const en = /en: (.*)/.exec(out)[1];
  assert.match(ru, /n = 5, в расчёт вошли 5 из 10 участников, остальные до первого прогноза не дошли; замер 2026-10-23/);
  assert.match(en, /n = 5, 5 of 10 participants are in the calculation, the rest did not reach the first forecast; measured 2026-10-23/);
  assert.match(out, /n: 5, started: 10, median_ms: \d+ \}\),/, 'строка зеркала несёт started');
  // тексты проходят линтер слов
  const forbidden = VOCAB.forbidden_phrases.map((p) => p.toLowerCase().replace(/ё/g, 'е'));
  for (const text of [ru, en]) {
    const low = text.toLowerCase().replace(/ё/g, 'е');
    for (const p of forbidden) assert.ok(!low.includes(p), '«' + p + '»');
    assert.deepEqual(LINT.lint_text(text, { file: 'text', vocab: VOCAB }).filter((x) => x.level === 'error'), []);
  }
});

test('REQ-110 FIX-3 командная строка: 8 из 10 — без предупреждения; 6 из 6 — started = n; 5 из 11 (меньше половины) — отказ без медианы, реестр не тронут', () => {
  const eight = cohort_files(8, 2);
  const io8 = fake_io(eight.files, '2026-10-23');
  assert.equal(OM.main([...eight.names, '--date', '2026-10-23', '--registry', REG, '--write'], io8), 0);
  assert.doesNotMatch(io8.outs.join('\n'), /Предупреждение/);
  assert.equal(JSON.parse(eight.files[REG]).at(-1).started, 10);

  const all = cohort_files(6, 0);
  const io6 = fake_io(all.files, '2026-10-23');
  assert.equal(OM.main([...all.names, '--date', '2026-10-23', '--registry', REG, '--write'], io6), 0);
  const rec = JSON.parse(all.files[REG]).at(-1);
  assert.deepEqual([rec.n, rec.started], [6, 6]);
  assert.match(io6.outs.join('\n'), /n = 6, до первого прогноза дошли все 6 начавших; замер 2026-10-23/);
  assert.match(io6.outs.join('\n'), /all 6 participants who started reached the first forecast/);
  assert.doesNotMatch(io6.outs.join('\n'), /остальные до первого прогноза не дошли/, 'когда дошли все, «остальных» нет');

  const few = cohort_files(5, 6);
  const io11 = fake_io(few.files, '2026-10-23');
  assert.equal(OM.main([...few.names, '--date', '2026-10-23', '--registry', REG, '--write'], io11), 1);
  const out = io11.outs.join('\n');
  assert.match(out, /Отказ: до результата дошли 5 из 11 начавших, меньше 50 %/);
  assert.doesNotMatch(out, /Медиана:/);
  assert.equal(io11.writes.length, 0);
  assert.equal(few.files[REG], REAL_REGISTRY_TEXT);
});

test('REQ-110 FIX-3 запись и тексты: make_record с cohort несёт started, без cohort — прежняя форма; started меньше n и доля ниже половины отвергаются; зеркало и тексты называют «n из started»', () => {
  const ev6 = OM.evaluate([300, 360, 420, 480, 540, 600].map((s) => s * 1000));
  const plain = OM.make_record('first_forecast', ev6, '2026-11-02');
  assert.ok(!('started' in plain), 'прежняя форма без cohort');
  const rec = OM.make_record('first_forecast', ev6, '2026-11-02', { started: 8 });
  assert.deepEqual([rec.n, rec.started, rec.level], [6, 8, 'measured']);
  assert.throws(() => OM.make_record('first_forecast', ev6, '2026-11-02', { started: 5 }), (e) => e.code === 'cohort_invalid');
  assert.throws(() => OM.make_record('first_forecast', ev6, '2026-11-02', { started: 'x' }), (e) => e.code === 'cohort_invalid');
  assert.throws(() => OM.make_record('first_forecast', ev6, '2026-11-02', { started: 13 }), (e) => e.code === 'reach_below_min');
  assert.doesNotThrow(() => OM.make_record('first_forecast', ev6, '2026-11-02', { started: 12 }));
  assert.throws(() => OM.merge_record(JSON.parse(REAL_REGISTRY_TEXT), { ...rec, started: 3 }), (e) => e.code === 'registry_invalid');
  assert.ok(OM.merge_record(JSON.parse(REAL_REGISTRY_TEXT), rec).at(-1).started === 8);

  const f = OM.followups('first_forecast', rec);
  assert.match(f.mirror, /n: 6, started: 8, median_ms: 450000 \}\),$/);
  assert.ok(f.texts.ru.includes('в расчёт вошли 6 из 8 участников') && f.texts.en.includes('6 of 8 participants'));
  const q = OM.followups('quick_entry', OM.make_record('quick_entry', ev6, '2026-11-02', { started: 8 }));
  assert.ok(q.texts.ru.includes('полный набор попыток у 6 из 8 человек') && q.texts.en.includes('6 of 8 people have a full set of attempts'));
  // без cohort тексты прежние: n и дата рядом с цифрой
  assert.ok(OM.followups('first_forecast', plain).texts.ru.includes('(n = 6; замер 2026-11-02)'));
});

// ── низкие дефекты ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-090 FIX-4 лист наблюдателя: копия с другим порядком ключей — копия; повтор человека с тем же набором попыток (в том числе в другом порядке) не засчитывается; считаются начавшие', () => {
  const persons = [1, 2, 3].map((k) => ({ attempts_s: [2 + k, 3 + k, 4 + k] }));
  const a = JSON.stringify({ format: 'runway-timing/1', measure: 'quick_entry', persons });
  const b = JSON.stringify({ persons, measure: 'quick_entry', format: 'runway-timing/1' });
  const r = OM.read_timing_values([{ name: 'a', text: a }, { name: 'b', text: b }]);
  assert.equal(r.used.length, 3);
  assert.deepEqual(r.skipped.map((s) => [s.name, s.reason, s.detail]), [['b', 'duplicate', 'a']]);
  assert.equal(r.started, 3);

  // тот же человек повторён внутри листа и в другом листе; попытки в другом порядке — тот же набор
  const dup = OM.read_timing_values([
    { name: 's1', text: sheet([{ attempts_s: [4.1, 3.9, 5.2] }, { attempts_s: [4.1, 3.9, 5.2] }, { attempts_s: [6.0, 6.1, 5.9] }]) },
    { name: 's2', text: sheet([{ attempts_s: [5.2, 4.1, 3.9] }, { attempts_s: [7.4, 7.0, 7.7] }]) },
  ]);
  assert.deepEqual(dup.used.map((u) => u.name), ['s1#1', 's1#3', 's2#2']);
  assert.deepEqual(dup.skipped.map((s) => [s.name, s.reason, s.detail]), [['s1#2', 'duplicate_person', 's1#1'], ['s2#1', 'duplicate_person', 's1#1']]);
  assert.equal(dup.started, 3);
});

test('REQ-090 FIX-5 лист наблюдателя: человек с неполным набором (меньше 3 попыток) начал, но в n не входит; пять людей с одной попыткой — n = 0 и отказ в командной строке', () => {
  assert.equal(OM.TIMING_LIMITS.min_attempts, 3);
  const r = OM.read_timing_values([{ name: 's', text: sheet([{ attempts_s: [3.0, 3.2, 3.4] }, { attempts_s: [4.0] }, { attempts_s: [5.1, 5.3] }, { attempts_s: [6.1, 6.0, 6.2, 6.4] }]) }]);
  assert.deepEqual(r.used.map((u) => [u.name, u.ms]), [['s#1', 3200], ['s#4', 6150]]);
  assert.deepEqual(r.skipped.map((s) => [s.name, s.reason, s.detail]), [['s#2', 'incomplete_attempts', '1'], ['s#3', 'incomplete_attempts', '2']]);
  assert.equal(r.started, 4);

  const five_single = sheet([1, 2, 3, 4, 5].map((k) => ({ attempts_s: [2 + k] })));
  const rr = OM.read_timing_values([{ name: 's', text: five_single }]);
  assert.equal(rr.used.length, 0);
  assert.equal(rr.started, 5);
  const io = fake_io({ 's.json': five_single, [REG]: REAL_REGISTRY_TEXT }, '2026-12-31');
  assert.equal(OM.main(['s.json', '--measure', 'quick_entry', '--registry', REG, '--date', '2026-11-02', '--write'], io), 1);
  const out = io.outs.join('\n');
  assert.match(out, /начали: 5 · учтено людей \(n\): 0/);
  assert.match(out, /неполный набор попыток/);
  assert.match(out, /Отказ: учтено n = 0 из 5 обязательных/);
  assert.equal(io.writes.length, 0);

  // 5 людей с полным набором из 8 начавших: запись и тексты называют «5 из 8»
  const mixed = sheet([...[1, 2, 3, 4, 5].map((k) => ({ attempts_s: [2 + k, 2.5 + k, 3 + k] })), ...[6, 7, 8].map((k) => ({ attempts_s: [k] }))]);
  const io2 = fake_io({ 's.json': mixed, [REG]: REAL_REGISTRY_TEXT }, '2026-12-31');
  assert.equal(OM.main(['s.json', '--measure', 'quick_entry', '--registry', REG, '--date', '2026-11-02', '--write'], io2), 0, io2.outs.join('\n'));
  const rec = JSON.parse(io2.writes[0][1]).at(-1);
  assert.deepEqual([rec.id, rec.n, rec.started], ['quick_entry_time', 5, 8]);
  assert.match(io2.outs.join('\n'), /полный набор попыток у 5 из 8 человек/);
});

test('REQ-110 FIX-6 «активное время»: потолок простоя в инструменте равен настоящему таймеру мастера; протокол и предложенный текст говорят «урезано до 60 с», а не «паузы исключены»', () => {
  let t = 0;
  const timer = WZ.create_step_timer({ now_ms: () => t });
  timer.enter('account');
  t += 10 * 60 * 1000;
  timer.touch();
  assert.equal(timer.seconds('account'), OM.IDLE_CAP_SECONDS, 'пауза в 10 минут засчитана как потолок простоя');
  assert.equal(OM.IDLE_CAP_SECONDS, 60);
  assert.match(PROTOCOL, /не исключаются, а урезаются/);
  assert.match(PROTOCOL, /не дольше \*\*60 секунд\*\*/);
  assert.doesNotMatch(PROTOCOL, /без пауз дольше порога простоя/);
  assert.doesNotMatch(PROTOCOL, /настенное время включает паузы и разговоры, активное — нет/);
  const ev = OM.evaluate([300, 360, 420, 480, 540].map((s) => s * 1000));
  const f = OM.followups('first_forecast', OM.make_record('first_forecast', ev, '2026-11-02', { started: 5 }));
  assert.match(f.texts.ru, /Каждая пауза между действиями засчитана не дольше 60 с/);
  assert.match(f.texts.en, /Each pause between actions counts for at most 60 s/);
});

test('REQ-090 REQ-110 FIX-2/3/4 протокол замера описывает исправленное поведение: сверка даты и --today, «кто не дошёл» (начавшие, 80 % и 50 %), полный набор из трёх попыток, поле started', () => {
  assert.match(PROTOCOL, /--today ГГГГ-ММ-ДД/);
  assert.match(PROTOCOL, /дата из будущего/);
  assert.match(PROTOCOL, /\*\*Кто не дошёл до прогноза\.\*\*/);
  assert.match(PROTOCOL, /меньше 80 %/);
  assert.match(PROTOCOL, /меньше 50 %/);
  assert.match(PROTOCOL, /полный набор — не менее трёх засчитанных попыток/);
  assert.match(PROTOCOL, /поле `started`/);
  assert.match(PROTOCOL, /при n меньше 5 отказывается/);
  // правило линтера «первый прогноз за N минут» по-прежнему видит только пример в таблице «Нельзя»
  const outside = PROTOCOL.split('\n').filter((ln) => !/первый прогноз за 7 минут/.test(ln)).join('\n');
  assert.ok(!/первый\s+прогноз\s+за\s+\d+\s+минут/i.test(outside));
  assert.deepEqual(LINT.lint_text(outside, { file: '_ops/people/timing-protocol.md', vocab: VOCAB }).filter((x) => x.level === 'error'), []);
});

test('REQ-186 FIX-7 страница плана: CSV и hledger названы неполными, полная копия — только файл runway-journal/1; перечень потерь приложения — на экране «Данные»', () => {
  assert.match(PAGE, /\*\*CSV и hledger — не полная копия:\*\*/);
  assert.match(PAGE, /только из файла-копии `runway-journal\/1`/);
  assert.match(PAGE, /`data\.losses_csv`/);
  const catalogs = DATA.catalogs.filter((c) => c.file === 'prototype/demo/i18n/data.mjs');
  assert.equal(catalogs.length, 1);
  for (const lang of ['ru', 'en']) {
    assert.equal(typeof catalogs[0][lang]['data.losses_csv'], 'string', lang + ': data.losses_csv есть в каталоге');
    assert.equal(typeof catalogs[0][lang]['data.losses_hledger'], 'string', lang + ': data.losses_hledger есть в каталоге');
  }
  assert.deepEqual(LINT.lint_text(PAGE, { file: 'wiki/product/20-if-developer-disappears.md', vocab: VOCAB }).filter((x) => x.level === 'error'), []);
  assert.match(PAGE, /^updated: 2026-10-24$/m);
});
