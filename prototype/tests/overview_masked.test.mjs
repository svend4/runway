// overview_masked.test.mjs — FP-47, часть 6 (REQ-067, REQ-108, C-024, TST-56): при отключённом налоговом правиле (статус `disabled`: проверка старше двух сроков годности)
// «Обзор» и «Сценарии» не печатают ряд «свободно» — число зависит от резервов, а резервы — от правила. Подпись точки графика, таблица значений и строки сравнения сценариев
// вместо числа называют дату проверки правила (`reviewed_at`): «не подтверждено с <даты>». Тот же гейт, что на «Резервах» (`rule_age.free_masked_since`).
// Тест идёт на настоящем app.mjs (заглушка DOM из tests/dom_boot.mjs); и «свежее» правило проверено рядом — чтобы «нет на странице» что-то доказывало.
// Расчёт по введённым данным и правилам, не консультация. Браузер, сервер и сеть не используются.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/overview_masked.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot_app, find_all, N, DEMO } from './dom_boot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);

const api = await boot_app({ raf: true });
const E = await imp('engine/index.mjs');
const RULE_AGE = await imp('demo/rule_age.mjs');
const I18N = await imp('demo/i18n.mjs');
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const ctx = api.ext.ctx;
const iso_ago = (ws, n) => E.format_date(E.to_epoch_day(ws.as_of) - n);

/** G-001 с отметкой проверки правила `age` дней назад и сроком годности `ttl` дней: `fresh` при age ≤ ttl, `stale` до 2·ttl, дальше `disabled`. */
function with_rule_age(age, ttl) {
  const ws = clone(G);
  ws.tax_rules[0].reviewed_at = iso_ago(ws, age);
  ws.tax_rules[0].ttl_days = ttl;
  return ws;
}
const FRESH = with_rule_age(5, 30);
const STALE = with_rule_age(40, 30);
const OFF = with_rule_age(100, 30);
const REVIEWED_OFF = iso_ago(G, 100);

async function show(ws, hash) {
  const r = ctx.set_ws(ws, { reason: 'test_reset' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await api.go(hash);
  await api.tick();
  await new Promise((res) => setTimeout(res, 20)); // requestAnimationFrame графика
}

const main_text = () => N(api.main().textContent);
const readout = () => N(find_all(api.main(), (n) => n.className === 'readout')[0].textContent);
const values_details = () => find_all(api.main(), (n) => n.tagName === 'details' && /(^|\s)values(\s|$)/.test(n.className))[0];
const head_cells = (root) => find_all(find_all(root, (n) => n.tagName === 'thead')[0], (n) => n.tagName === 'th').map((n) => N(n.textContent));
const body_rows = (root) => find_all(find_all(root, (n) => n.tagName === 'tbody')[0], (n) => n.tagName === 'tr');
const cells_of = (tr) => tr.children.filter((c) => c.tagName === 'td' || c.tagName === 'th');

// ── чистый гейт ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-067 FP-47 free_masked_since: null, пока нет отключённых правил (свежее и просроченное не отключены); иначе самая давняя дата проверки; без даты — пустая строка', () => {
  const status = (ws) => E.analyze(ws, { as_of: ws.as_of }).rule_status;
  assert.deepEqual(status(FRESH), { 'TR-20': 'fresh' });
  assert.deepEqual(status(STALE), { 'TR-20': 'stale' });
  assert.deepEqual(status(OFF), { 'TR-20': 'disabled' });
  assert.equal(RULE_AGE.free_masked_since(FRESH, FRESH.as_of, status(FRESH)), null);
  assert.equal(RULE_AGE.free_masked_since(STALE, STALE.as_of, status(STALE)), null, 'stale — только предупреждение, числа на месте');
  assert.equal(RULE_AGE.free_masked_since(OFF, OFF.as_of, status(OFF)), REVIEWED_OFF);
  assert.equal(RULE_AGE.free_masked_since(OFF, OFF.as_of, undefined), null);
  // два отключённых правила: называется самое давнее
  const two = clone(OFF);
  two.tax_rules.push({ ...clone(OFF.tax_rules[0]), tax_rule_id: 'TR-OLD', reviewed_at: iso_ago(OFF, 200), reserve_id: OFF.tax_rules[0].reserve_id });
  assert.equal(RULE_AGE.free_masked_since(two, two.as_of, { 'TR-20': 'disabled', 'TR-OLD': 'disabled' }), iso_ago(OFF, 200));
  // статус disabled, а даты проверки в данных нет: числа скрыты, дата — пустая строка (экран напишет «—»)
  assert.equal(RULE_AGE.free_masked_since(G, G.as_of, { 'TR-NONE': 'disabled' }), '');
});

// ── «Обзор»: график и таблица значений ───────────────────────────────────────────────────────────────────────────────────

test('REQ-067 FP-47 «Обзор» при свежем правиле: подпись точки графика и таблица значений печатают «свободно» (две колонки с числами); число 935,00 € есть', async () => {
  await show(FRESH, '#overview');
  assert.match(readout(), /свободно 2 942,00 €; если хуже.+свободно 710,00 €\./, readout()); // узкая точка «если хуже» 14 ноября: свободно по плану 2 942,00 €, если хуже 710,00 € (канон G-001, §9.4)
  const d = values_details();
  assert.ok(d !== undefined);
  const head = head_cells(d);
  assert.equal(head.length, 8, 'дата, статус и три колонки на режим');
  assert.equal(head.filter((h) => /свободно/.test(h)).length, 2);
  assert.ok(body_rows(d).every((tr) => cells_of(tr).length === 8));
  assert.ok(N(d.textContent).includes('935,00'), 'минимум «свободно» по плану 935,00 € в таблице');
  assert.equal(find_all(d, (n) => n.attrs.id === 'ov-table-free-off').length, 0, 'пояснения про скрытый ряд нет');
});

test('REQ-067 FP-47 «Обзор» при правиле disabled: подпись точки графика называет дату reviewed_at и не печатает «свободно»; в таблице значений нет колонок «свободно», над ней — текст с датой', async () => {
  await show(OFF, '#overview');
  const r = readout();
  assert.ok(!/свободно \d/.test(r) && !/свободно [-−]?\d/.test(r), 'числа «свободно» в подписи точки нет: ' + r);
  assert.match(r, /«Свободно» не показано: правило не подтверждено с 2026-06-26\./, r);
  assert.ok(r.includes(REVIEWED_OFF), 'дата — reviewed_at действующей версии правила');
  assert.match(r, /по плану — минимум дня .+ на конец дня .+; если хуже — минимум дня .+ на конец дня/, 'остаток наличными по-прежнему называется');
  const d = values_details();
  const head = head_cells(d);
  assert.equal(head.length, 6, 'дата, статус и две колонки на режим');
  assert.equal(head.filter((h) => /свободно/.test(h)).length, 0, head.join(' | '));
  assert.ok(body_rows(d).length >= 50 && body_rows(d).every((tr) => cells_of(tr).length === 6), 'в каждой строке на два числа меньше');
  const note = find_all(d, (n) => n.attrs.id === 'ov-table-free-off')[0];
  assert.ok(note !== undefined, 'над таблицей есть пояснение');
  assert.equal(N(note.textContent), 'Ряд «свободно» не показан: правило не подтверждено с ' + REVIEWED_OFF + '; числа, которые зависят от резервов, скрыты до подтверждения или правки правила.');
  const region = find_all(d, (n) => n.attrs.role === 'region')[0];
  assert.match(region.attrs['aria-label'], /ряд «свободно» не показан/);
  assert.match(N(find_all(d, (n) => n.tagName === 'caption')[0].textContent), /ряд «свободно» не показан/);
  assert.ok(!N(d.textContent).includes('935,00') && !N(d.textContent).includes('710,00'), 'канон G-001: минимумы «свободно» 935,00 и 710,00 € нигде в таблице не видны');
  assert.ok(!main_text().includes('935,00'), 'и на всём «Обзоре»');
  assert.ok(main_text().includes(REVIEWED_OFF), 'дата проверки правила на странице названа');
});

test('REQ-067 FP-47 правило просрочено, но не отключено (stale): числа «свободно» на месте; после «подтвердить правило» (новая дата проверки) отключённое состояние снимается и колонки возвращаются', async () => {
  await show(STALE, '#overview');
  assert.match(readout(), /свободно \d/);
  assert.equal(head_cells(values_details()).length, 8);
  await show(OFF, '#overview');
  assert.equal(head_cells(values_details()).length, 6);
  const edit = ctx.edit({ type: 'upsert_tax_rule', tax_rule: { ...clone(OFF.tax_rules[0]), reviewed_at: OFF.as_of, version: (OFF.tax_rules[0].version ?? 1) + 1, valid_from: OFF.as_of } });
  assert.equal(edit.ok, true, JSON.stringify(edit.error)); // «подтвердить правило»: новая версия с сегодняшней датой проверки, общий путь записи
  await api.go('#overview');
  await api.tick();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(head_cells(values_details()).length, 8, 'правило подтверждено: ряд «свободно» вернулся');
  assert.match(readout(), /свободно \d/);
  assert.equal(find_all(values_details(), (n) => n.attrs.id === 'ov-table-free-off').length, 0);
});

// ── «Сценарии»: сравнение ───────────────────────────────────────────────────────────────────────────────────────────────

const row_of = (label) => find_all(api.main(), (n) => n.tagName === 'tr').find((tr) => N(cells_of(tr)[0]?.textContent ?? '') === label);

test('REQ-067 FP-47 «Сценарии»: при свежем правиле строки «Минимум свободных» с числами; при disabled в обеих строках стоит «не подтверждено с <даты>», чисел 935,00 и 710,00 нет', async () => {
  await show(FRESH, '#scenarios');
  const plan = row_of('Минимум свободных, по плану');
  const worse = row_of('Минимум свободных, если хуже');
  assert.ok(plan !== undefined && worse !== undefined);
  assert.match(N(cells_of(plan)[1].textContent), /^935,00\s€$/);
  assert.match(N(cells_of(worse)[1].textContent), /^710,00\s€$/);
  await show(OFF, '#scenarios');
  for (const label of ['Минимум свободных, по плану', 'Минимум свободных, если хуже']) {
    const tr = row_of(label);
    assert.ok(tr !== undefined, label);
    assert.equal(N(cells_of(tr)[1].textContent), 'не подтверждено с ' + REVIEWED_OFF, label);
  }
  assert.ok(!main_text().includes('935,00') && !main_text().includes('710,00'), 'чисел «свободно» на экране нет');
  // остальные строки сравнения (деньги на счетах) на месте
  assert.match(N(cells_of(row_of('Минимум на счетах, по плану'))[1].textContent), /2\s?055,00\s€/);
});

// ── язык, строки, безопасность ──────────────────────────────────────────────────────────────────────────────────────────

test('REQ-067 FP-47 EN: подпись точки, пояснение над таблицей и строки сценариев называют дату на английском; числа «free» не печатаются', async () => {
  api.set_lang('en');
  await api.tick();
  await show(OFF, '#overview');
  assert.match(readout(), /"Free" is not shown: the rule has not been confirmed since 2026-06-26\./, readout());
  assert.ok(!/free [€$]?\d|free \d/i.test(readout().replace('"Free" is not shown', '')), 'числа free в подписи нет: ' + readout());
  const d = values_details();
  assert.equal(head_cells(d).length, 6);
  assert.match(N(find_all(d, (n) => n.attrs.id === 'ov-table-free-off')[0].textContent), /^The "free" series is not shown: the rule has not been confirmed since 2026-06-26;/);
  await show(OFF, '#scenarios');
  const tr = find_all(api.main(), (n) => n.tagName === 'tr').find((r) => /^Lowest free money, as planned$/.test(N(cells_of(r)[0]?.textContent ?? '')));
  assert.equal(N(cells_of(tr)[1].textContent), 'not confirmed since 2026-06-26');
  api.set_lang('ru');
  await api.tick();
});

test('TST-56 FP-47 новые строки ov.readout_masked, ov.table_free_masked, ov.table_caption_masked, sc.free_masked: RU и EN, одинаковые плейсхолдеры, русские буквы только в RU, ключ использован литералом в app.mjs', () => {
  const holders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const src = fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8');
  const expect = { 'ov.readout_masked': 'date,cp,cw,since,tp,tw', 'ov.table_free_masked': 'since', 'ov.table_caption_masked': '', 'sc.free_masked': 'since' };
  for (const [key, ph] of Object.entries(expect)) {
    const ru = I18N.STRINGS.ru[key];
    const en = I18N.STRINGS.en[key];
    assert.equal(typeof ru, 'string', key + ' RU');
    assert.equal(typeof en, 'string', key + ' EN');
    assert.match(ru, /[А-Яа-яЁё]/);
    assert.doesNotMatch(en, /[А-Яа-яЁё]/);
    assert.equal(holders(ru), holders(en), key + ': плейсхолдеры');
    assert.equal(holders(ru), ph.split(',').filter(Boolean).sort().join(','), key + ': набор плейсхолдеров');
    assert.ok(src.includes("'" + key + "'"), key + ' использован литералом в app.mjs');
  }
  // в сообщениях нет числа «свободно» и запрещённых слов
  for (const lang of ['ru', 'en']) for (const key of Object.keys(expect)) assert.doesNotMatch(I18N.STRINGS[lang][key], /безопасно|гарантир|спокойно|guarantee|safe\b/i, key);
});

test('FP-47 безопасность и доступность: новый текст идёт через textContent (h()), без innerHTML и inline-стилей; у таблицы подпись, у блока прокрутки — имя, фокус не трогается', async () => {
  await show(OFF, '#overview');
  const d = values_details();
  let bad = 0;
  d.walk((n) => { if (n.attrs.style !== undefined) bad += 1; });
  assert.equal(bad, 0, 'inline-стилей нет');
  assert.ok(find_all(d, (n) => n.tagName === 'caption' && N(n.textContent).trim() !== '').length === 1);
  const region = find_all(d, (n) => n.attrs.role === 'region')[0];
  assert.equal(region.attrs.tabindex, '0');
  assert.ok(region.attrs['aria-label'].length > 10);
  const src = fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8').split('\n');
  const mine = src.filter((l) => /free_off|free_gate_since|free_masked_since/.test(l));
  assert.ok(mine.length >= 8 && mine.every((l) => !/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(l)), 'строки правки без небезопасных вставок');
  // хуки расширений не потребовались: число строк с `ext` в app.mjs не выросло сверх предела пакета волн (25)
  assert.ok(src.filter((l) => !/^\s*(\/\/|\*)/.test(l) && /\bext\b/.test(l)).length <= 25);
});
