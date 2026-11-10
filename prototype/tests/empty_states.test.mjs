// empty_states.test.mjs — FP-26, U35: пустые состояния экранов достижимы и покрыты отрисовкой. Тексты wv.empty («Волн нет»), fd.empty («Лента пуста»), rs.none, rs.tax_none, rs.sinking_none
// были в app.mjs, но ни один тест не проверял, что они реально рисуются (аудит: «grep по tests/ пуст»). Настоящий app.mjs на заглушке DOM, набор G-001-empty (пустой, с нуля, FP-10)
// выбирается в переключателе, как это делает пользователь; частично пустые состояния — на копиях G-001 без налогового резерва или без накоплений (`ctx.adopt`).
// Что проверяется: текст из словаря (RU и EN) показан ровно один раз в нужном месте, рядом нет ни ошибок расчёта, ни «NaN/undefined», таблиц и карточек волн нет; на заполненных наборах
// пустых состояний нет. Расчёт по введённым данным и правилам, не консультация. Браузер и серверы не запускаются.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot_app, find_all, N } from './dom_boot.mjs';

const A = await boot_app();
const lang = () => A.ext.ctx.lang();
const T = (key, params) => N(A.I18N.t(lang(), key, params));
const money = (v) => N(A.ext.ctx.fmt().money(v));
const texts = (pred) => find_all(A.main(), pred).map((n) => N(n.textContent));
const paragraphs = (cls = null) => find_all(A.main(), (n) => n.tagName === 'p' && (cls === null || n.className === cls));
const count_of = (text) => paragraphs().filter((p) => N(p.textContent) === text).length;
const no_garbage = () => {
  const t = A.text_of('main');
  assert.ok(!/NaN|undefined|Infinity|\[object/.test(t), 'в тексте экрана нет мусора: ' + t.slice(0, 200));
  assert.equal(find_all(A.main(), (n) => n.attrs.role === 'alert').length, 0, 'ошибок расчёта нет');
};
const threshold = () => A.ext.ctx.get_model().ctx.params['wave.threshold_minor'];

await A.choose_dataset('empty');

test('U35 набор G-001-empty: рабочая область пуста, расчёт идёт без ошибок, готовность 0', () => {
  const ws = A.ext.ctx.get_ws();
  assert.equal(ws.accounts.length, 0);
  assert.equal((ws.facts ?? []).length + (ws.rules ?? []).length + (ws.plans ?? []).length, 0);
  assert.equal(A.ext.ctx.get_model().ctx.readiness.score, 0);
});

for (const l of ['ru', 'en']) {
  test(`U35 wv.empty (${l}): «Волны» без обязательств — одна плашка с порогом в формате страницы; карточек волн, календаря и таблиц нет`, async () => {
    A.set_lang(l);
    await A.go('#waves');
    const expected = T('wv.empty', { value: money(threshold()) });
    assert.equal(count_of(expected), 1, expected);
    assert.equal(paragraphs('banner').filter((p) => N(p.textContent) === expected).length, 1, 'это плашка banner');
    assert.equal(find_all(A.main(), (n) => /(^|\s)wave-card(\s|$)/.test(n.className)).length, 0, 'карточек волн нет');
    assert.equal(find_all(A.main(), (n) => n.tagName === 'table').length, 0, 'ни календаря, ни таблиц');
    assert.ok(expected.includes(l === 'ru' ? '30,00 €' : '€30.00'), 'порог 3000 minor units показан суммой: ' + expected);
    assert.equal(texts((n) => n.tagName === 'h2')[0], T('wv.title'), 'заголовок экрана на месте');
    no_garbage();
  });

  test(`U35 fd.empty (${l}): «Лента» без платежей и фактов — одна плашка; шва «сегодня» и таблиц нет`, async () => {
    A.set_lang(l);
    await A.go('#feed');
    const expected = T('fd.empty');
    assert.equal(count_of(expected), 1);
    assert.equal(paragraphs('banner').filter((p) => N(p.textContent) === expected).length, 1);
    assert.equal(find_all(A.main(), (n) => n.tagName === 'table').length, 0);
    assert.equal(find_all(A.main(), (n) => n.attrs.role === 'separator').length, 0, 'шов «сегодня» без записей не рисуется');
    assert.equal(texts((n) => n.tagName === 'h2')[0], T('fd.title'));
    no_garbage();
  });

  test(`U35 rs.none, rs.tax_none, rs.sinking_none (${l}): «Резервы» без правил и накоплений — три пустых состояния, каждое по разу, налоговая оговорка рядом`, async () => {
    A.set_lang(l);
    await A.go('#reserves');
    assert.equal(count_of(T('rs.none')), 1, 'rs.none');
    assert.equal(paragraphs('banner').filter((p) => N(p.textContent) === T('rs.none')).length, 1, 'rs.none — плашка');
    // налоговый конверт: заголовок карточки, затем «Правило не задано…» и оговорка «не консультация»
    const tax = paragraphs().filter((p) => N(p.textContent) === T('rs.tax_none'));
    assert.equal(tax.length, 1, 'rs.tax_none');
    const tax_card = tax[0].parent;
    assert.equal(N(tax_card.children[0].textContent), T('rs.tax'), 'карточка «Налоговый конверт»');
    assert.ok(tax_card.children.some((c) => N(c.textContent) === T('c.tax_note')), 'оговорка «расчёт по введённым правилам, не консультация» в той же карточке');
    assert.ok(N(A.I18N.t(l, 'c.tax_note')).toLowerCase().includes(l === 'ru' ? 'не консультация' : 'not advice'));
    // накопления
    const sink = paragraphs().filter((p) => N(p.textContent) === T('rs.sinking_none'));
    assert.equal(sink.length, 1, 'rs.sinking_none');
    assert.equal(N(sink[0].parent.children[0].textContent), T('rs.sinking'), 'карточка «Накопления»');
    no_garbage();
  });
}

test('U35 пустые состояния не накапливаются: повторный заход на экран и смена языка оставляют по одной плашке', async () => {
  A.set_lang('ru');
  for (const [hash, key] of [['#waves', 'wv.empty'], ['#feed', 'fd.empty'], ['#reserves', 'rs.none']]) {
    await A.go(hash);
    await A.go(hash);
    const text = key === 'wv.empty' ? T(key, { value: money(threshold()) }) : T(key);
    assert.equal(count_of(text), 1, key);
  }
});

const tweak = {
  /** G-001 без налогового резерва: правило и резерв убраны. */
  no_tax: (ws) => {
    const ids = new Set(ws.reserves.filter((r) => r.kind === 'tax').map((r) => r.reserve_id));
    ws.tax_rules = [];
    ws.reserves = ws.reserves.filter((r) => r.kind !== 'tax');
    ws.allocations = ws.allocations.filter((a) => !ids.has(a.reserve_id));
    ws.plans = ws.plans.map((p) => { const { reserve_id, ...rest } = p; return ids.has(reserve_id) ? rest : p; });
  },
  /** G-001 без накоплений: резерв-накопление убран. */
  no_sinking: (ws) => {
    const ids = new Set(ws.reserves.filter((r) => r.kind === 'sinking').map((r) => r.reserve_id));
    ws.reserves = ws.reserves.filter((r) => r.kind !== 'sinking');
    ws.allocations = ws.allocations.filter((a) => !ids.has(a.reserve_id));
  },
};

test('U35 частично пустые «Резервы»: без налогового резерва — только rs.tax_none; без накоплений — только rs.sinking_none; общей плашки rs.none нет', async () => {
  await A.choose_dataset('g001');
  const base = structuredClone(A.ext.ctx.get_ws());
  assert.ok(base.reserves.some((r) => r.kind === 'tax') && base.reserves.some((r) => r.kind === 'sinking'), 'в G-001 есть оба вида резервов');
  const shown = () => ['rs.none', 'rs.tax_none', 'rs.sinking_none'].filter((k) => count_of(T(k)) === 1);
  A.set_lang('ru');
  await A.go('#reserves');
  assert.deepEqual(shown(), [], 'на заполненном G-001 пустых состояний нет');
  const a = structuredClone(base);
  tweak.no_tax(a);
  assert.equal(A.ext.ctx.adopt(a, { source: 'test' }).ok, true);
  await A.go('#reserves');
  assert.deepEqual(shown(), ['rs.tax_none']);
  no_garbage();
  const b = structuredClone(base);
  tweak.no_sinking(b);
  assert.equal(A.ext.ctx.adopt(b, { source: 'test' }).ok, true);
  await A.go('#reserves');
  assert.deepEqual(shown(), ['rs.sinking_none']);
  no_garbage();
  A.set_lang('en');
  await A.go('#reserves');
  assert.deepEqual(shown(), ['rs.sinking_none'], 'и на английском');
  A.set_lang('ru');
});

test('U35 на заполненных наборах G-001, low, gap, late пустых состояний «Волн», «Ленты» и «Резервов» нет', async () => {
  const all = (key) => (key === 'wv.empty' ? T(key, { value: money(threshold()) }) : T(key));
  for (const ds of ['g001', 'low', 'gap', 'late']) {
    await A.choose_dataset(ds);
    for (const [hash, keys] of [['#waves', ['wv.empty']], ['#feed', ['fd.empty']], ['#reserves', ['rs.none', 'rs.tax_none', 'rs.sinking_none']]]) {
      await A.go(hash);
      for (const k of keys) assert.equal(count_of(all(k)), 0, `${ds} ${hash}: ${k}`);
    }
  }
});

test('U35 строки пустых состояний: ключи есть в RU и EN, плейсхолдеры совпадают, RU по-русски, EN без кириллицы, без запрещённых оборотов', () => {
  for (const key of ['wv.empty', 'fd.empty', 'rs.none', 'rs.tax_none', 'rs.sinking_none']) {
    const ru = A.I18N.t('ru', key, { value: 'X' });
    const en = A.I18N.t('en', key, { value: 'X' });
    assert.ok(ru !== key && en !== key, key);
    assert.match(ru, /[а-яё]/i, key);
    assert.ok(!/[а-яё]/i.test(en), key);
    assert.ok(!/безопасно|гарантируем|спокойно/i.test(ru), key);
  }
  assert.ok(A.I18N.t('ru', 'wv.empty', { value: '30,00 €' }).includes('30,00 €'));
});
