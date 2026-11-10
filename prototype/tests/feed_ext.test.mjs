// feed_ext.test.mjs — FP-28: «Лента» (счётчик «Сверка: N», оговорка об усечении, «Почему» и «Исправить» у строк), удалённая оговорка «в демо лента только для чтения»,
// сообщения о нехватке с ближайшим ожидаемым поступлением (REQ-046: G-001-low и G-001-gap) и чистая модель shortage.nearest_income.
// Настоящий app.mjs на заглушке DOM (tests/dom_boot.mjs): пакет pack_fp28 подхвачен манифестом, запись идёт общим путём ctx.set_ws, «Отменить» — единая стопка FP-04.
// Что проверяется: текст, числа и порядок действий; данные не меняются при отказах; «Исправить» — одна единица «Отменить» и одна пара записей журнала; режим «только чтение» называет
// причину; фокус возвращается на заголовок. Расчёт по введённым данным и правилам, не консультация. Браузер и серверы не запускаются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { boot_app, find_all, N } from './dom_boot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const FX = await imp('demo/feed_ext.mjs');
const FF = await imp('demo/fact_fix.mjs');
const SH = await imp('demo/shortage.mjs');
const { reconcile_model, facts_page } = await imp('demo/reconcile.mjs');
const { canon, format_date, answer_q1 } = await imp('engine/index.mjs');
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));

const A = await boot_app();
const ctx = A.ext.ctx;
const lang = () => ctx.lang();
const T = (key, params) => N(A.I18N.t(lang(), key, params));
const text = () => A.text_of('main');
const by_id = (id) => find_all(A.main(), (n) => n.attrs.id === id)[0];
const click = (n) => n.listeners.click[0]({ preventDefault() {}, target: n });
const dlg_text = () => A.text_of('dlg-body');
const dlg_by_id = (id) => find_all(A.byid.get('dlg-body'), (n) => n.attrs.id === id)[0];
const undo_btn = () => find_all(A.nav(), (n) => n.tagName === 'button' && n.className.includes('undo-btn'))[0];
const redo_btn = () => find_all(A.nav(), (n) => n.tagName === 'button' && n.className.includes('undo-btn'))[1];
const facts = () => ctx.get_ws().facts;
const reset = async (id = 'g001') => { await A.choose_dataset(id); A.set_lang('ru'); await A.go('#feed'); };

await A.go('#feed');

// ── 1. оговорка «в демо лента только для чтения» ─────────────────────────────────────────────────────────────────────

test('FP-28 (1) fd.demo_note не показывается: в тексте «Ленты» нет оговорки ни по-русски, ни по-английски, а ключ остаётся в каталоге приложения', async () => {
  for (const l of ['ru', 'en']) {
    A.set_lang(l);
    await A.go('#feed');
    for (const key of FX.RETIRED_KEYS) {
      const phrase = N(A.I18N.STRINGS[l][key]);
      assert.ok(phrase.length > 20, 'ключ ' + key + ' остаётся в каталоге: ' + phrase);
      assert.ok(!text().includes(phrase), `${l}: оговорка «${phrase}» есть в ленте`);
    }
    assert.ok(!/read-only|только для чтения/.test(text()), l + ': нет слов «только для чтения»: ' + text().slice(0, 200));
    assert.ok(text().includes(T('fd.past')), 'лента на месте');
  }
  assert.deepEqual([...FX.RETIRED_KEYS], ['fd.demo_note']);
  A.set_lang('ru');
});

// ── 2. «Сверка: N» и усечение ───────────────────────────────────────────────────────────────────────────────────────

test('FP-28 (4) счётчик «Сверка: N» — ссылка на #reconcile; N равен очереди сверки; при пустой очереди сказано словами', async () => {
  await reset();
  const link = by_id('feedx-recon-link');
  assert.ok(link !== undefined);
  assert.equal(link.attrs.href, '#reconcile');
  assert.equal(link.tagName, 'a');
  assert.equal(N(link.textContent), 'Сверка: 0');
  assert.equal(reconcile_model(ctx.get_ws()).queue.length, 0);
  assert.ok(text().includes(T('feedx.recon_zero')));
  // «Сегодня» позже: плановые платежи без фактов становятся просроченными — очередь не пуста, счётчик её повторяет
  const r = ctx.edit({ type: 'set_as_of', date: '2026-11-03' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await A.go('#feed');
  const m = reconcile_model(ctx.get_ws());
  assert.ok(m.queue.length > 0, 'очередь сверки не пуста');
  assert.equal(N(by_id('feedx-recon-link').textContent), 'Сверка: ' + m.queue.length);
  assert.ok(text().includes(T('feedx.recon_detail', { overdue: m.counts.overdue, double: m.counts.double, partial: m.counts.partial })), text().slice(0, 400));
  A.set_lang('en');
  await A.go('#feed');
  assert.equal(N(by_id('feedx-recon-link').textContent), 'Reconcile: ' + m.queue.length);
  A.set_lang('ru');
  const back = undo_btn();
  assert.equal(back.attrs.disabled, undefined, 'правка «Сегодня» отменяется');
});

test('FP-28 (4) усечение до 8 последних фактов оговорено: «Показаны последние 8; всего фактов: 28»; при 8 и меньше фактов оговорки нет', async () => {
  await reset();
  assert.equal(ctx.get_ws().facts.length, 28);
  assert.equal(find_all(A.main(), (n) => n.tagName === 'table')[0].children[2].children.length, 8, 'в таблице прошлого 8 строк');
  assert.ok(text().includes('Показаны последние 8; всего фактов: 28. Полный список — в «Сверке», раздел «Все факты».'), text().slice(0, 300));
  A.set_lang('en');
  await A.go('#feed');
  assert.ok(text().includes('The latest 8 are shown; 28 actuals in total.'), text().slice(0, 300));
  A.set_lang('ru');
  const small = { ...G, facts: G.facts.slice(-5) };
  assert.equal(ctx.adopt(small).ok, true);
  await A.go('#feed');
  assert.ok(!text().includes('Показаны последние'), 'пять фактов — оговорки нет');
  assert.equal(by_id('feedx-cut'), undefined);
  assert.equal(N(by_id('feedx-recon-link').textContent).startsWith('Сверка:'), true, 'счётчик остаётся');
  await reset();
});

test('FP-28 лента без платежей и фактов: пустое состояние прежнее, счётчика и действий нет', async () => {
  await A.choose_dataset('empty');
  await A.go('#feed');
  assert.ok(text().includes(T('fd.empty')));
  assert.equal(by_id('feedx-recon-link'), undefined);
  assert.equal(find_all(A.main(), (n) => n.tagName === 'button').length, 0);
  await reset();
});

// ── 3. «Почему» ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-28 (4) у каждой строки ленты есть «Почему», у каждого факта (кроме ног перевода) — «Исправить»; подписи для скринридера называют строку', async () => {
  await reset();
  const why = find_all(A.main(), (n) => n.tagName === 'button' && /^feedx-why-/.test(n.attrs.id ?? ''));
  const fix = find_all(A.main(), (n) => n.tagName === 'button' && /^feedx-fix-/.test(n.attrs.id ?? ''));
  const fm = (await imp('demo/app.mjs')).feed_model(ctx.get_model(), ctx.mode(), 'ru');
  assert.equal(why.length, fm.past.length + fm.future.length, 'по «Почему» на строку');
  assert.equal(fix.length, fm.past.length, '«Исправить» только у фактов');
  assert.equal(new Set([...why, ...fix].map((b) => b.attrs.id)).size, why.length + fix.length, 'идентификаторы уникальны');
  assert.equal(N(why[0].attrs['aria-label']), 'Почему эта строка: продукты, 12 сентября');
  assert.equal(N(fix[0].attrs['aria-label']), 'Исправить запись: продукты, 12 сентября, −100,00 €');
  for (const b of [...why, ...fix]) assert.ok(N(b.textContent) === 'Почему' || N(b.textContent) === 'Исправить');
});

test('FP-28 «Почему» у планового события: аренда в режиме «если хуже» — источник, номинальная и эффективная дата, волна, минимум с этой строкой и без неё (разница 900,00 €)', async () => {
  await reset();
  const model = ctx.get_model();
  const w = FX.future_why(model, 'worse', 'R-RENT@2026-10-25');
  assert.equal(w.source, 'rule');
  assert.equal(w.amount_minor, -90000);
  assert.deepEqual([format_date(w.nominal), format_date(w.date)], ['2026-10-25', '2026-10-26'], 'воскресенье сдвинуто на понедельник');
  assert.equal(w.wave, 1);
  assert.deepEqual([w.effect.min.amount_minor, format_date(w.effect.min.date)], [183000, '2026-11-14']);
  assert.deepEqual([w.effect.without.amount_minor, w.effect.delta_minor], [273000, 90000], 'то же, что контрфакт «без аренды» в «Почему» узкой точки');
  const income = FX.future_why(model, 'worse', 'S-HOURLY@2026-11-05');
  assert.equal(income.source, 'stream');
  assert.equal(format_date(income.other_date), '2026-11-05', 'в режиме «по плану» поступление раньше');
  assert.ok(income.effect.delta_minor < 0, 'без поступления минимум был бы ниже: ' + income.effect.delta_minor);
  assert.equal(FX.future_why(model, 'worse', 'нет-такого'), null);
  // на экране: кнопка у строки аренды открывает диалог с теми же числами
  A.nav(); // режим страницы — «если хуже» (набор G-001 по умолчанию)
  const rent_row = find_all(A.main(), (n) => n.tagName === 'tr' && N(n.textContent).startsWith('26 окт' + 'Аренда'));
  assert.equal(rent_row.length, 1, 'строка аренды 26 октября одна');
  const btn = find_all(rent_row[0], (n) => n.tagName === 'button')[0];
  click(btn);
  const d = dlg_text();
  assert.ok(d.includes('Аренда: −900,00 € на 26 октября; режим «если хуже», статус «ожидается».'), d);
  assert.ok(d.includes('Источник: повторяющийся платёж по правилу «Аренда».'));
  assert.ok(d.includes('Номинальная дата — 25 октября; в режиме «если хуже» событие попадает на 26 октября.'));
  assert.ok(d.includes('Входит в волну 1'));
  assert.ok(d.includes('Минимум денег на счетах в режиме «если хуже» — 1 830,00 € (14 ноября). Без этой строки он был бы 2 730,00 € (14 ноября); разница 900,00 €.'), d);
  assert.equal(A.byid.get('dlg').open, true);
  assert.equal(A.byid.get('dlg-title').textContent, 'Почему в ленте: Аренда');
});

test('FP-28 «Почему» у факта: сопоставление со сверкой и вклад в остаток (покрыт сверкой остатка или входит в него)', async () => {
  await reset();
  const ws = ctx.get_ws();
  const matched = FX.past_why(ws, 'tx-g001-27');
  assert.deepEqual([matched.state, matched.by, matched.covered_by_anchor, matched.fixable, matched.anchor], ['matched', 'auto', true, true, '2026-10-04'], 'последний якорь 10-04 покрывает все факты G-001');
  const outside = FX.past_why(ws, 'tx-g001-26');
  assert.deepEqual([outside.state, outside.covered_by_anchor], ['outside', true]);
  assert.equal(FX.past_why(ws, 'нет-такого'), null);
  // факт позже последней сверки остатка входит в остаток на «сегодня»
  const later = { ...ws, as_of: '2026-10-08', facts: [...ws.facts, { event_id: 'tx-late', account_id: 'acc_main', date: '2026-10-06', amount_minor: -1000, currency: 'EUR', kind: 'expense' }] };
  const counted = FX.past_why(later, 'tx-late');
  assert.deepEqual([counted.covered_by_anchor, counted.anchor, counted.state], [false, '2026-10-04', 'unmatched']);
  // на экране
  const row = find_all(A.main(), (n) => n.tagName === 'tr' && N(n.textContent).startsWith('3 окт' + 'продукты'))[0];
  click(find_all(row, (n) => n.tagName === 'button')[0]);
  const d = dlg_text();
  assert.ok(d.includes('Факт от 3 октября: −100,00 €, счёт «acc_main».') || d.includes('Факт от 3 октября: −100,00 €'), d);
  assert.ok(d.includes('Сверка: ни к одному плановому платежу не привязан.'), d);
  assert.ok(d.includes('Дата не позже сверки остатка (4 октября)'), d);
  const income_row = find_all(A.main(), (n) => n.tagName === 'tr' && N(n.textContent).startsWith('2 окт' + 'Выплата за часы'))[0];
  click(find_all(income_row, (n) => n.tagName === 'button')[0]);
  assert.ok(dlg_text().includes('Сверка: сопоставлен с плановым платежом'), dlg_text());
});

// ── 4. «Исправить факт» ──────────────────────────────────────────────────────────────────────────────────────────────

const open_fix = async (tag_text) => {
  await A.go('#feed');
  const row = find_all(A.main(), (n) => n.tagName === 'tr' && N(n.textContent).includes(tag_text) && find_all(n, (b) => b.tagName === 'button' && /^feedx-fix-/.test(b.attrs.id ?? '')).length === 1)[0];
  assert.ok(row !== undefined, 'нет строки ' + tag_text);
  click(find_all(row, (b) => b.tagName === 'button' && /^feedx-fix-/.test(b.attrs.id ?? ''))[0]);
  return { amount: dlg_by_id('fx-amount'), date: dlg_by_id('fx-date'), tag: dlg_by_id('fx-tag'), note: dlg_by_id('fx-note'), error: dlg_by_id('fx-error'), form: find_all(A.byid.get('dlg-body'), (n) => n.tagName === 'form')[0] };
};
const submit = (f) => f.form.listeners.submit[0]({ preventDefault() {} });

test('FP-28 (2) «Исправить факт»: диалог показывает текущие значения; исправление — void_fact + add_fact одним пересчётом; «Отменить» возвращает прежний факт, «Вернуть» — исправленный', async () => {
  await reset();
  const before = ctx.get_ws();
  const old = before.facts.find((f) => f.event_id === 'tx-g001-28');
  assert.equal(old.amount_minor, -10000);
  const f = await open_fix('3 окт' + 'продукты');
  assert.equal(f.amount.value, '−100,00', 'сумма в формате чисел, расход со знаком');
  assert.equal(f.date.value, '2026-10-03');
  assert.equal(f.tag.value, 'продукты');
  assert.equal(A.byid.get('dlg').open, true);
  const journal_before = ctx.journal.events().length;
  f.amount.value = '−125,50';
  f.date.value = '2026-10-02';
  f.tag.value = 'продукты (рынок)';
  f.note.value = 'исправлено вручную';
  submit(f);
  assert.equal(f.error.textContent, '', 'без ошибок: ' + f.error.textContent);
  const after = ctx.get_ws();
  assert.equal(A.byid.get('dlg').open, false, 'диалог закрыт');
  assert.equal(after.facts.length, before.facts.length, 'число фактов то же: один убран, один добавлен');
  assert.equal(after.facts.find((x) => x.event_id === 'tx-g001-28'), undefined, 'прежний факт убран');
  const fixed = after.facts.find((x) => x.tag === 'продукты (рынок)');
  assert.ok(fixed !== undefined);
  assert.deepEqual([fixed.amount_minor, fixed.date, fixed.account_id, fixed.currency, fixed.kind, fixed.note], [-12550, '2026-10-02', 'acc_main', 'EUR', 'expense', 'исправлено вручную']);
  assert.notEqual(fixed.event_id, 'tx-g001-28', 'новый идентификатор');
  assert.equal(ctx.journal.events().length, journal_before + 2, 'в журнале две записи: откат прежней и новая; прежние записи не менялись');
  assert.ok(N(A.byid.get('live').textContent).includes('Запись исправлена: −125,50 €, 2 октября. Прежнюю возвращает «Отменить».'), A.byid.get('live').textContent);
  // «Отменить» — одна единица
  assert.equal(undo_btn().attrs.disabled, undefined);
  assert.match(N(undo_btn().attrs['aria-label']), /исправление записи 125,50 €/);
  click(undo_btn());
  assert.equal(canon(ctx.get_ws()), canon(before), 'после «Отменить» рабочая область побайтно прежняя (один шаг, а не два)');
  assert.equal(ctx.get_ws().facts.find((x) => x.event_id === 'tx-g001-28').amount_minor, -10000);
  click(redo_btn());
  assert.equal(canon(ctx.get_ws()), canon(after), '«Вернуть» ставит исправленный факт обратно');
  click(undo_btn());
});

test('FP-28 «Исправить факт»: сохраняются привязка к плану, контрагент и ключ дедупликации; знак суммы без «−»/«+» берётся прежний; «+» делает приход; ошибки не меняют данные', async () => {
  await reset();
  const ws0 = ctx.get_ws();
  const keep = { ...ws0.facts.find((x) => x.event_id === 'tx-g001-27'), plan_ref: 'S-HOURLY@2026-10-02', dedup_key: 'bank-123' };
  const ws1 = { ...ws0, facts: ws0.facts.map((x) => (x.event_id === 'tx-g001-27' ? keep : x)) };
  assert.equal(ctx.set_ws(ws1, { reason: 'test' }).ok, true);
  const built = FF.build_fix(ctx.get_ws(), 'tx-g001-27', { amount_text: '2900', date: '2026-10-02', tag: 'S-HOURLY' }, { lang: 'ru', new_id: ctx.new_id });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual([built.fact.plan_ref, built.fact.dedup_key, built.fact.amount_minor, built.fact.kind], ['S-HOURLY@2026-10-02', 'bank-123', 290000, 'income'], 'без знака — прежний знак (приход)');
  const flip = FF.build_fix(ctx.get_ws(), 'tx-g001-28', { amount_text: '+50', date: '2026-10-03' }, { lang: 'ru', new_id: ctx.new_id });
  assert.deepEqual([flip.fact.amount_minor, flip.fact.kind], [5000, 'income'], '«+» делает приход');
  const snap = canon(ctx.get_ws());
  const f = await open_fix('3 окт' + 'продукты');
  for (const [value, expect] of [['abc', /Сумма|сумм/i], ['0', /нул|0|сумм/i]]) {
    f.amount.value = value;
    submit(f);
    assert.notEqual(f.error.textContent, '', 'ошибка для «' + value + '»');
    assert.ok(!/E_[A-Z_]+/.test(f.error.textContent), 'без кодов ошибок: ' + f.error.textContent);
    assert.equal(canon(ctx.get_ws()), snap, 'данные не изменились');
    assert.equal(A.byid.get('dlg').open, true, 'диалог остался открытым');
  }
  f.amount.value = '−100,00';
  submit(f);
  assert.equal(f.error.textContent, T('feedx.fx_nochange'), 'поля совпадают с записью: ничего не изменено');
  f.amount.value = '−90';
  f.date.value = '2027-01-01';
  submit(f);
  assert.notEqual(f.error.textContent, '', 'дата после «сегодня»');
  assert.equal(canon(ctx.get_ws()), snap);
  f.date.value = '2026-10-03';
  f.amount.value = '−90';
  submit(f);
  assert.equal(f.error.textContent, '');
  assert.equal(ctx.get_ws().facts.some((x) => x.amount_minor === -9000), true, 'после исправления ошибки запись прошла');
});

test('FP-28 «Исправить факт»: перевод (две связанные ноги) не правится — кнопки нет, модель отказывает; чужой идентификатор — отказ без изменений', async () => {
  await reset();
  const ws = ctx.get_ws();
  const accounts = [...ws.accounts, { account_id: 'acc_save', name: 'Запас', kind: 'bank', liquidity: 'savings', currency: 'EUR' }];
  assert.equal(ctx.set_ws({ ...ws, accounts }, { reason: 'test' }).ok, true);
  const r = ctx.edit({ type: 'add_fact', legs: [{ account_id: 'acc_main', date: '2026-10-04', amount_minor: -5000 }, { account_id: 'acc_save', date: '2026-10-04', amount_minor: 5000 }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await A.go('#feed');
  const legs = ctx.get_ws().facts.filter((x) => typeof x.transfer_id === 'string');
  assert.equal(legs.length, 2);
  assert.equal(FF.fixable_fact(ctx.get_ws(), legs[0].event_id).reason, 'transfer');
  const rows = find_all(A.main(), (n) => n.tagName === 'tr' && find_all(n, (b) => b.tagName === 'button' && /^feedx-why-p/.test(b.attrs.id ?? '')).length === 1);
  const transfer_rows = rows.filter((row) => find_all(row, (b) => /^feedx-fix-/.test(b.attrs.id ?? '')).length === 0);
  assert.equal(transfer_rows.length, 2, 'у обеих ног перевода «Исправить» нет: ' + transfer_rows.length);
  const snap = canon(ctx.get_ws());
  const bad = FF.build_fix(ctx.get_ws(), legs[0].event_id, { amount_text: '10', date: '2026-10-04' }, { lang: 'ru', new_id: ctx.new_id });
  assert.deepEqual([bad.ok, bad.error.ctx.reason], [false, 'transfer_not_fixable']);
  assert.equal(FF.build_fix(ctx.get_ws(), 'нет-такого', { amount_text: '10' }, { lang: 'ru', new_id: ctx.new_id }).error.ctx.reason, 'unknown_fact');
  assert.equal(FF.commit_fix(ctx, 'нет-такого', { amount_text: '10' }).ok, false);
  assert.equal(canon(ctx.get_ws()), snap);
  // «Почему» у ноги перевода говорит, что она не правится
  click(find_all(transfer_rows[0], (b) => b.tagName === 'button')[0]);
  assert.ok(dlg_text().includes(T('feedx.fx_transfer_only')), dlg_text());
  await reset();
});

test('FP-28 «Исправить факт» в режиме «только чтение»: кнопка называет причину текстом ro.refused, диалог не открывается, данные не меняются', async () => {
  await reset();
  const ws = ctx.get_ws();
  assert.equal(ctx.adopt(ws, { read_only: { newer_format: true, format: 'runway-journal/99', format_version: 99, skipped: 0 } }).ok, true);
  assert.notEqual(ctx.read_only(), null);
  await A.go('#feed');
  A.byid.get('dlg').open = false;
  const btn = find_all(A.main(), (n) => n.tagName === 'button' && /^feedx-fix-p0$/.test(n.attrs.id ?? ''))[0];
  const snap = canon(ctx.get_ws());
  click(btn);
  assert.equal(A.byid.get('dlg').open, false, 'диалог не открылся');
  assert.ok(N(A.byid.get('live').textContent).includes(T('ro.refused')), A.byid.get('live').textContent);
  assert.equal(canon(ctx.get_ws()), snap);
  assert.equal(FF.commit_fix(ctx, 'tx-g001-28', { amount_text: '−1' }).error.ctx.reason, 'read_only');
  await reset();
  assert.equal(ctx.read_only(), null, 'выбор набора данных снимает режим');
});

test('FP-28 фокус после «Исправить»: кнопка исправленной строки — новый узел, фокус возвращается на заголовок экрана, а не падает на body', async () => {
  await reset();
  A.emulate_focus_loss(true);
  try {
    const f = await open_fix('3 окт' + 'продукты');
    f.amount.focus();
    f.amount.value = '−77';
    submit(f);
    globalThis.document.activeElement = globalThis.document.body; // диалог закрылся, а кнопка-источник заменена: фокус упал на body
    await A.tick();
    await A.tick();
    assert.equal(globalThis.document.activeElement.attrs.id, 'view-title', 'фокус на заголовке «Ленты»');
  } finally { A.emulate_focus_loss(false); }
  await reset();
});

// ── 5. сообщения о нехватке (REQ-046) ───────────────────────────────────────────────────────────────────────────────

const overview_text = async (id, l = 'ru') => { await A.choose_dataset(id); A.set_lang(l); await A.go('#overview'); return text(); };
const FORBIDDEN_IMPERATIVES = /сдвиньте|сократите|отложите|продайте|возьмите|перенесите|отмените покупку|\b(?:move|cut|sell|postpone|reduce) (?:the|your)\b/i;

test('FP-28 (3) REQ-046 G-001-low (режим нехватки: впритык): сообщения называют дату минимума, «не хватает до буфера» двух рядов и ближайшее ожидаемое поступление каждого режима', async () => {
  const t = await overview_text('low');
  assert.ok(t.includes('по плану: минимум на счетах 255,00 € · 31 октября — ниже буфера 500,00 €; не хватает до буфера (деньги на счетах): 245,00 €. Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €.'), t);
  assert.ok(t.includes('если хуже: минимум на счетах 30,00 € · 14 ноября — ниже буфера 500,00 €; не хватает до буфера (деньги на счетах): 470,00 €. Ближайшее ожидаемое поступление — 19 ноября: 2 790,00 €.'), t);
  assert.ok(t.includes('До 19 ноября: до буфера не хватает 1 365,00 € (с учётом резервов), режим «по плану». Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €.'), t);
  assert.ok(t.includes('До 19 ноября: до буфера не хватает 1 590,00 € (с учётом резервов), режим «если хуже». Ближайшее ожидаемое поступление — 19 ноября: 2 790,00 €.'), t);
  assert.ok(!FORBIDDEN_IMPERATIVES.test(t), 'на экране нет «ходов»');
  // тот же факт в данных: поступление — первое событие дохода режима на дату минимума или позже
  const m = ctx.get_model().ctx;
  for (const [mode, want] of [['plan', '2026-11-05'], ['worse', '2026-11-19']]) {
    const n = SH.nearest_income(m.events[mode], m.series[mode].from + m.series[mode].trough.indexOf(Math.min(...m.series[mode].trough)));
    assert.equal(format_date(n.date), want, mode);
    assert.equal(n.amount_minor, 279000);
  }
});

test('FP-28 (3) REQ-046 G-001-gap (денег на счетах не хватает): первая дата, need (деньги на счетах), short_to_buffer (с учётом резервов) и ближайшее поступление; на английском то же', async () => {
  const t = await overview_text('gap');
  assert.ok(t.includes('по плану: денег на счетах не хватает: первая дата — 26 октября (−845,00 €), через 22 дня; не хватает до буфера (деньги на счетах): 1 445,00 €. Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €.'), t);
  assert.ok(t.includes('если хуже: денег на счетах не хватает: первая дата — 26 октября (−845,00 €), через 22 дня; не хватает до буфера (деньги на счетах): 1 670,00 €. Ближайшее ожидаемое поступление — 19 ноября: 2 790,00 €.'), t);
  assert.ok(t.includes('До 19 ноября: до буфера не хватает 2 565,00 € (с учётом резервов), режим «по плану». Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €.'), t);
  assert.ok(t.includes('До 19 ноября: до буфера не хватает 2 790,00 € (с учётом резервов), режим «если хуже». Ближайшее ожидаемое поступление — 19 ноября: 2 790,00 €.'), t);
  assert.ok(!FORBIDDEN_IMPERATIVES.test(t));
  const en = await overview_text('gap', 'en');
  assert.ok(en.includes('as planned: money on the accounts runs out: first date — October 26 (−€845.00), in 22 days; short of the buffer (money on accounts): €1,445.00. The nearest expected income is on November 5: €2,790.00.'), en.slice(0, 1200));
  assert.ok(en.includes('Until November 19: short of the buffer by €2,565.00 (after reserves), “as planned” mode. The nearest expected income is on November 5: €2,790.00.'), en.slice(0, 1200));
  assert.ok(!FORBIDDEN_IMPERATIVES.test(en));
  A.set_lang('ru');
});

test('FP-28 (3) REQ-046 G-001-late: после даты нехватки поступлений в горизонте нет — это сказано отдельной фразой, а не молчанием', async () => {
  const t = await overview_text('late');
  assert.ok(t.includes('До конца горизонта (30 ноября) — 0: не хватает до буфера 1 278,00 €. Ожидаемых поступлений после этой даты в горизонте нет.'), t);
});

test('FP-28 (3) REQ-046 «Купить» в G-001-low: «до буфера не хватает» по режимам с ближайшим поступлением', async () => {
  await A.choose_dataset('low');
  await A.go('#buy');
  const t = text();
  assert.ok(t.includes('по плану: До буфера не хватает 1 365,00 € (с учётом резервов). Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €.'), t.slice(0, 1500));
  assert.ok(!FORBIDDEN_IMPERATIVES.test(t));
  await reset();
});

test('FP-28 nearest_income (чистая): поступление в день отсчёта или позже, суммой за день; расходы и нулевые суммы не считаются; нет поступлений — null', () => {
  const ev = (id, date, amount, kind = amount > 0 ? 'income' : 'expense') => ({ cash_event_id: id, date, amount_minor: amount, kind });
  const events = [ev('a', 100, -500), ev('b', 105, 300), ev('c', 105, 200), ev('d', 110, 700), ev('e', 104, 0, 'income'), ev('f', 103, 900, 'expense')];
  assert.deepEqual(SH.nearest_income(events, 100), { date: 105, amount_minor: 500, count: 2 });
  assert.deepEqual(SH.nearest_income(events, 105), { date: 105, amount_minor: 500, count: 2 }, 'день отсчёта входит');
  assert.deepEqual(SH.nearest_income(events, 106), { date: 110, amount_minor: 700, count: 1 });
  assert.equal(SH.nearest_income(events, 111), null);
  assert.equal(SH.nearest_income([], 100), null);
  assert.equal(SH.nearest_income(undefined, 100), null);
  assert.deepEqual(SH.nearest_income(events, '1970-04-11'), { date: 105, amount_minor: 500, count: 2 }, 'ISO-дата отсчёта тоже принимается (день 100 = 1970-04-11)');
});

test('FP-28 REQ-046 на экране нет императивов вне «проверьте / введите / сверьте» — по каталогам строк приложения и пакета FP-28', async () => {
  const cat = (await imp('demo/i18n/feedx.mjs')).default;
  const strings = [...Object.values(cat.ru), ...Object.values(A.I18N.STRINGS.ru).filter((s) => /ближайшее ожидаемое|Ожидаемых поступлений/.test(s))];
  const bad = strings.filter((s) => /(?:^|[\s«(—:;,])(?:[А-ЯЁа-яё]{3,}(?:йте|ьте|ите))(?=[\s.,;:!?»)]|$)/u.test(s) && !/(?:^|[\s«(—:;,])(?:проверьте|введите|сверьте)(?=[\s.,;:!?»)]|$)/iu.test(s));
  assert.deepEqual(bad.filter((s) => !/(?:^|\s)(?:приведите|выглядите|пишите)/.test(s)), [], 'императивы: ' + bad.join(' | '));
  assert.ok(strings.some((s) => /проверьте/.test(s)), 'разрешённое «проверьте» используется');
});

// ── 6. после проверки: первая дата нарушения буфера, «Исправить» у старых фактов ─────────────────────────────────────────

test('FP-28 first_below (чистая): первый элемент ряда ниже буфера в окне; равный буферу — не ниже; без буфера, без ряда и за пределами окна — null; согласие с движком на всех наборах', async () => {
  const xs = [900, 700, 400, 600, 100];
  assert.equal(SH.first_below(xs, 100, 500), 102, '400 < 500 на третий день');
  assert.equal(SH.first_below(xs, 100, 500, 101), null, 'окно кончается раньше нарушения');
  assert.equal(SH.first_below(xs, 100, 500, 102), 102, 'последний день окна входит');
  assert.equal(SH.first_below(xs, 100, 500, 999), 102, 'окно шире ряда зажимается');
  assert.equal(SH.first_below(xs, 100, 400), 104, 'равно буферу — не ниже: нарушение только в 100 < 400');
  assert.equal(SH.first_below(xs, 100, 1000), 100, 'нарушение с первого дня');
  assert.equal(SH.first_below(xs, 100, 50), null);
  assert.equal(SH.first_below(xs, 100, null), null, 'буфер не задан — даты нет');
  assert.equal(SH.first_below(xs, 100, undefined), null);
  assert.equal(SH.first_below(undefined, 100, 500), null);
  assert.equal(SH.first_below([], 100, 500), null);
  const app = await imp('demo/app.mjs');
  for (const name of ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json']) {
    const ws = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
    const model = app.build_model(ws, { lang: 'ru' });
    for (const mode of ['plan', 'worse']) {
      const s = model.ctx.series[mode];
      for (const B of [0, 25000, 50000, 120000, 400000]) {
        const q = answer_q1(s, model.ctx.horizon_end, B);
        assert.equal(SH.first_below(s.trough, model.ctx.as_of, B), q.first_buffer_breach, `${name}/${mode}/B=${B}: совпадает с first_buffer_breach движка`);
      }
    }
  }
});

test('FP-28 (3) REQ-046 G-001-low: «первая дата нарушения» названа — деньги на счетах впервые ниже буфера 26 октября, с учётом резервов — 17 октября; оба режима, плашка, RU и EN', async () => {
  const t = await overview_text('low');
  const m = ctx.get_model().ctx;
  for (const mode of ['plan', 'worse']) {
    assert.equal(format_date(answer_q1(m.series[mode], m.horizon_end, m.buffer_minor).first_buffer_breach), '2026-10-26', mode + ': дата из движка (деньги на счетах)');
    assert.equal(format_date(SH.first_below(m.series[mode].free, m.as_of, m.buffer_minor)), '2026-10-17', mode + ': дата из ряда free (с учётом резервов)');
  }
  const cash = 'Деньги на счетах впервые ниже буфера — 26 октября.';
  const reserved = 'С учётом резервов свободные деньги впервые ниже буфера — 17 октября.';
  // прежние подстроки остаются, новая фраза стоит после ближайшего поступления
  assert.ok(t.includes('не хватает до буфера (деньги на счетах): 245,00 €. Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €. ' + cash), t);
  assert.ok(t.includes('не хватает до буфера (деньги на счетах): 470,00 €. Ближайшее ожидаемое поступление — 19 ноября: 2 790,00 €. ' + cash), t);
  assert.ok(t.includes('режим «по плану». Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €. ' + reserved), t);
  assert.ok(t.includes('режим «если хуже». Ближайшее ожидаемое поступление — 19 ноября: 2 790,00 €. ' + reserved), t);
  assert.equal(t.split(cash).length - 1, 3, 'два режима и плашка режима страницы: ' + (t.split(cash).length - 1));
  assert.equal(t.split(reserved).length - 1, 2, 'по строке на режим');
  assert.ok(!FORBIDDEN_IMPERATIVES.test(t));
  const en = await overview_text('low', 'en');
  assert.ok(en.includes('The money on the accounts first falls below the buffer on October 26.'), en.slice(0, 1500));
  assert.ok(en.includes('After reserves, the free money first falls below the buffer on October 17.'), en.slice(0, 1500));
  assert.ok(!FORBIDDEN_IMPERATIVES.test(en));
  A.set_lang('ru');
  // «Купить»: строка «до буфера не хватает» (с учётом резервов) тоже называет первую дату
  await A.go('#buy');
  assert.ok(text().includes('По плану: До буфера не хватает 1 365,00 € (с учётом резервов). Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €. ' + reserved)
    || text().includes('по плану: До буфера не хватает 1 365,00 € (с учётом резервов). Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €. ' + reserved), text().slice(0, 1800));
  await reset();
});

test('FP-28 (3) REQ-046: на G-001 нарушения нет — и даты нет; на G-001-gap и G-001-late «с учётом резервов» называет первую дату, в том числе у строки «до конца горизонта»', async () => {
  const ok = await overview_text('g001');
  assert.ok(!ok.includes('впервые ниже буфера'), 'набор G-001: нарушения нет — и даты нет');
  const gap = await overview_text('gap');
  assert.ok(gap.includes('режим «по плану». Ближайшее ожидаемое поступление — 5 ноября: 2 790,00 €. С учётом резервов свободные деньги впервые ниже буфера — 4 октября.'), gap);
  assert.ok(!gap.includes('Деньги на счетах впервые ниже буфера'), 'деньги на счетах уже ушли ниже нуля: названа первая дата нехватки (26 октября), а не «ниже буфера»');
  const late = await overview_text('late');
  assert.ok(late.includes('До конца горизонта (30 ноября) — 0: не хватает до буфера 1 278,00 €. Ожидаемых поступлений после этой даты в горизонте нет. С учётом резервов свободные деньги впервые ниже буфера — 26 ноября.'), late);
  await reset();
});

test('FP-28 тупика нет: факт старше последних 8 исправляется в «Сверке», куда ведёт оговорка об усечении; «Отменить» возвращает прежний; у ног перевода кнопки нет; на английском «Correct»', async () => {
  await reset();
  const app = await imp('demo/app.mjs');
  const shown = new Set(app.feed_model(ctx.get_model(), ctx.mode(), 'ru').past.map((p) => p.id));
  assert.equal(shown.size, 8);
  assert.ok(text().includes(T('feedx.cut', { shown: 8, total: 28 })), 'оговорка об усечении на месте');
  const ws0 = ctx.get_ws();
  await A.go('#reconcile');
  const page0 = facts_page(reconcile_model(ws0), 0);
  const buttons = find_all(A.main(), (n) => n.tagName === 'button' && /^rc-fx-\d+$/.test(n.attrs.id ?? ''));
  assert.equal(buttons.length, page0.rows.length, 'у каждого факта страницы (перевода нет) своя кнопка «Исправить»');
  assert.equal(new Set(buttons.map((b) => b.attrs.id)).size, buttons.length);
  const k = page0.rows.findIndex((r) => !shown.has(r.fact.id));
  assert.ok(k >= 0, 'на первой странице «Все факты» есть факт, которого нет в ленте');
  const old_row = page0.rows[k].fact; // строка модели «Сверки» (даты — числом)
  assert.ok(!shown.has(old_row.id));
  const old = ws0.facts.find((x) => x.event_id === old_row.id); // запись рабочей области
  assert.ok(old !== undefined);
  const btn = by_id('rc-fx-' + k);
  assert.equal(N(btn.textContent), 'Исправить');
  assert.ok(N(btn.attrs['aria-label']).startsWith('Исправить: '), btn.attrs['aria-label']);
  click(btn);
  assert.equal(A.byid.get('dlg').open, true, 'диалог «Исправить запись» открылся из «Сверки»');
  const amount = dlg_by_id('fx-amount');
  assert.equal(amount.value, FF.amount_field_text(ws0, old, 'ru'), 'в поле — текущая сумма старого факта');
  amount.value = (old.amount_minor < 0 ? '−' : '') + '13,37';
  A.emulate_focus_loss(true);
  try {
    amount.focus();
    find_all(A.byid.get('dlg-body'), (n) => n.tagName === 'form')[0].listeners.submit[0]({ preventDefault() {} });
    assert.equal(dlg_by_id('fx-error')?.textContent ?? '', '');
    const after = ctx.get_ws();
    assert.equal(after.facts.find((x) => x.event_id === old.event_id), undefined, 'прежний факт убран');
    const fixed = after.facts.find((x) => Math.abs(x.amount_minor) === 1337 && x.date === old.date);
    assert.ok(fixed !== undefined, 'исправленный факт добавлен');
    assert.equal(after.facts.length, ws0.facts.length);
    globalThis.document.activeElement = globalThis.document.body; // кнопка строки заменена: фокус упал на body
    await A.tick();
    await A.tick();
    assert.equal(globalThis.document.activeElement.attrs.id, 'view-title', 'фокус вернулся на заголовок «Сверки»');
  } finally { A.emulate_focus_loss(false); }
  assert.match(N(undo_btn().attrs['aria-label']), /исправление записи 13,37 €/);
  click(undo_btn());
  assert.equal(canon(ctx.get_ws()), canon(ws0), '«Отменить» одним шагом возвращает прежний факт');
  // перевод: у ног кнопки нет, у остальных фактов есть
  const accounts = [...ws0.accounts, { account_id: 'acc_save', name: 'Запас', kind: 'bank', liquidity: 'savings', currency: 'EUR' }];
  assert.equal(ctx.set_ws({ ...ws0, accounts }, { reason: 'test' }).ok, true);
  assert.equal(ctx.edit({ type: 'add_fact', legs: [{ account_id: 'acc_main', date: '2026-10-04', amount_minor: -5000 }, { account_id: 'acc_save', date: '2026-10-04', amount_minor: 5000 }] }).ok, true);
  await A.go('#reconcile');
  const ws1 = ctx.get_ws();
  const rows1 = facts_page(reconcile_model(ws1), 0).rows;
  const legs_on_page = rows1.filter((r) => !FF.fixable_fact(ws1, r.fact.id).ok).length;
  assert.equal(legs_on_page, 2, 'обе ноги перевода на первой странице');
  assert.equal(find_all(A.main(), (n) => n.tagName === 'button' && /^rc-fx-\d+$/.test(n.attrs.id ?? '')).length, rows1.length - 2, 'кнопок на две меньше: ноги перевода не правятся');
  A.set_lang('en');
  await A.go('#reconcile');
  assert.equal(N(find_all(A.main(), (n) => n.tagName === 'button' && /^rc-fx-\d+$/.test(n.attrs.id ?? ''))[0].textContent), 'Correct');
  A.set_lang('ru');
  await reset();
});
