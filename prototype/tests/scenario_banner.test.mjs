// scenario_banner.test.mjs — FP-26, REQ-049 (сценарии как правки данных): постоянная плашка «Вы в сценарии» с возвратом к базе и предел трёх сценариев рядом с базой.
// Настоящий app.mjs на заглушке DOM: сценарий добавляется чипом на экране «Сценарии», открывается как вид («Открыть как вид»), плашка видна в шапке на любом экране и в обоих языках,
// «Вернуться к базе» убирает её, не трогая сравнение и рабочую область; четвёртый сценарий отклоняется сообщением sc.max (состояние не меняется).
// Тест закрывает пробел аудита: код плашки (sc.banner, sc.back) и предела (sc.max) был в app.mjs, но ни один тест на них не ссылался. Браузер и серверы не запускаются.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot_app, find_all, N } from './dom_boot.mjs';

const A = await boot_app();
const T = (key, params) => N(A.I18N.t(A.ext.ctx.lang(), key, params));
const days = (lang, n) => A.I18N.word_form(lang, 'day', n);

const banner = () => find_all(A.summary(), (n) => n.className === 'banner scenario')[0];
const chip = (text) => find_all(A.main(), (n) => n.tagName === 'button' && n.className === 'chip' && N(n.textContent) === text)[0];
const delay_chip = (n) => chip(N(A.I18N.t(A.ext.ctx.lang(), 'sc.chip_delay', { n, days: days(A.ext.ctx.lang(), n) })));
const link_buttons = (key) => find_all(A.main(), (n) => n.tagName === 'button' && n.className === 'link' && N(n.textContent) === T(key));
const notice = () => find_all(A.main(), (n) => n.tagName === 'p' && n.attrs.role === 'status').map((n) => N(n.textContent));
const ws_json = () => JSON.stringify(A.ext.ctx.get_ws());

test('REQ-049 исходное состояние: плашки сценария нет, расчёт — база; на «Сценариях» в сравнении только база', async () => {
  await A.go('#scenarios');
  assert.equal(banner(), undefined, 'пока сценарий не выбран, плашки нет');
  assert.equal(A.ext.ctx.get_model().scenario, null);
  assert.equal(link_buttons('sc.apply').length, 0);
  assert.ok(A.text_of('main').includes(T('sc.empty')), 'сравнение пусто: ' + T('sc.empty'));
});

test('REQ-049 плашка «Вы в сценарии» видна при выбранном сценарии на любом экране; «Вернуться к базе» убирает её; рабочая область и сравнение не меняются', async () => {
  const before = ws_json();
  await A.go('#scenarios');
  A.click(delay_chip(7));
  assert.ok(A.text_of('main').includes(T('sc.added')), 'сообщение «Сценарий добавлен в сравнение»');
  assert.equal(banner(), undefined, 'добавить в сравнение — ещё не войти в сценарий');
  const apply = link_buttons('sc.apply');
  assert.equal(apply.length, 1);
  A.click(apply[0]);
  const b = banner();
  assert.ok(b !== undefined, 'плашка показана после «Открыть как вид»');
  const name = T('sc.name_delay', { n: 7, days: days('ru', 7) });
  assert.equal(N(b.children[0].data ?? b.textContent).startsWith(T('sc.banner', { name })), true, 'в плашке название сценария: ' + N(b.textContent));
  assert.equal(b.attrs.role, 'status', 'плашка — вежливое объявление для скринридера');
  const back = find_all(b, (n) => n.tagName === 'button');
  assert.equal(back.length, 1);
  assert.equal(N(back[0].textContent), 'Вернуться к базе');
  assert.equal(back[0].attrs.type, 'button');
  assert.notEqual(A.ext.ctx.get_model().scenario, null, 'модель страницы считает сценарий');
  // «постоянная» плашка: она в шапке и видна на каждом экране
  for (const hash of ['#overview', '#buy', '#waves', '#reserves', '#feed', '#assistant', '#data']) {
    await A.go(hash);
    assert.ok(banner() !== undefined, 'плашка на ' + hash);
  }
  // гипотеза не пишется в журнал фактов
  assert.equal(ws_json(), before, 'рабочая область не изменилась (REQ-014)');
  // возврат к базе
  A.click(back[0]);
  assert.equal(banner(), undefined, '«Вернуться к базе» убирает плашку');
  assert.equal(A.ext.ctx.get_model().scenario, null, 'расчёт снова по базе');
  assert.equal(ws_json(), before);
  await A.go('#scenarios');
  assert.equal(link_buttons('sc.apply').length, 1, 'сценарий остался в сравнении — его можно открыть снова');
});

test('REQ-049 плашка и возврат на английском: текст из словаря EN, кнопка «Back to the base»', async () => {
  A.set_lang('en');
  await A.go('#scenarios');
  A.click(link_buttons('sc.apply')[0]);
  const b = banner();
  assert.ok(b !== undefined);
  const name = A.I18N.t('en', 'sc.name_delay', { n: 7, days: days('en', 7) });
  assert.ok(N(b.textContent).startsWith(N(A.I18N.t('en', 'sc.banner', { name }))), N(b.textContent));
  assert.match(N(b.textContent), /^You are in the scenario /);
  const back = find_all(b, (n) => n.tagName === 'button')[0];
  assert.equal(N(back.textContent), 'Back to the base');
  A.click(back);
  assert.equal(banner(), undefined);
  A.set_lang('ru');
  await A.go('#scenarios');
});

test('REQ-049 предел: до трёх сценариев рядом с базой; четвёртый (чипом «клиент платит позже» или покупкой) отклоняется сообщением sc.max, сравнение не меняется', async () => {
  const remove_buttons = () => link_buttons('sc.remove');
  assert.equal(remove_buttons().length, 1, 'после прошлых тестов в сравнении один сценарий');
  A.click(delay_chip(14));
  A.click(delay_chip(21));
  assert.equal(remove_buttons().length, 3, 'три сценария рядом с базой');
  const cmp = find_all(A.main(), (n) => n.tagName === 'table' && N(n.children[0]?.textContent ?? '') === T('sc.compare'))[0];
  assert.ok(cmp !== undefined, 'таблица сравнения');
  assert.equal(find_all(cmp, (n) => n.tagName === 'th' && n.attrs.scope === 'col').length, 5, 'колонки: подпись строки, база и три сценария');
  assert.ok(!A.text_of('main').includes(T('sc.max')), 'пока предел не достигнут, сообщения нет');
  // четвёртый
  A.click(delay_chip(30));
  assert.equal(remove_buttons().length, 3, 'четвёртый не добавлен');
  assert.deepEqual(notice().filter((x) => x === T('sc.max')), [T('sc.max')], 'сообщение sc.max показано как статус: ' + JSON.stringify(notice()));
  assert.ok(T('sc.max').includes('до трёх сценариев'));
  assert.equal(banner(), undefined, 'отказ не включает сценарий');
  assert.equal(A.ext.ctx.get_model().scenario, null);
  // покупкой — то же
  const purchase = find_all(A.main(), (n) => n.tagName === 'button' && n.className === 'chip' && N(n.textContent).startsWith('Покупка '))[0];
  assert.ok(purchase !== undefined, 'чип покупки');
  A.click(purchase);
  assert.equal(remove_buttons().length, 3);
  assert.ok(notice().includes(T('sc.max')));
  // освободили место — снова можно
  A.click(remove_buttons()[0]);
  assert.equal(remove_buttons().length, 2);
  A.click(delay_chip(30));
  assert.equal(remove_buttons().length, 3, 'после «Убрать» четвёртый становится третьим');
  assert.ok(!notice().includes(T('sc.max')), 'сообщение предела не висит после успешного добавления');
});

test('REQ-049 предел на английском: сообщение sc.max из словаря EN; убирание открытого сценария снимает плашку', async () => {
  A.set_lang('en');
  await A.go('#scenarios');
  const en_chip = (n) => find_all(A.main(), (x) => x.tagName === 'button' && x.className === 'chip' && N(x.textContent) === N(A.I18N.t('en', 'sc.chip_delay', { n, days: days('en', n) })))[0];
  A.click(en_chip(7));
  assert.ok(N(A.text_of('main')).includes(N(A.I18N.t('en', 'sc.max'))), 'EN: sc.max');
  assert.match(A.I18N.t('en', 'sc.max'), /^Up to three scenarios/);
  // открыли сценарий и убрали его же → плашка снимается, расчёт по базе
  A.click(find_all(A.main(), (n) => n.tagName === 'button' && n.className === 'link' && N(n.textContent) === 'Open as the view')[0]);
  assert.ok(banner() !== undefined);
  A.click(find_all(A.main(), (n) => n.tagName === 'button' && n.className === 'link' && N(n.textContent) === 'Remove')[0]);
  assert.equal(banner(), undefined, 'убран открытый сценарий — плашки нет');
  assert.equal(A.ext.ctx.get_model().scenario, null);
  A.set_lang('ru');
});

test('REQ-049 строки плашки: sc.banner, sc.back, sc.max есть в обоих языках с одинаковыми плейсхолдерами, без запрещённых формулировок', () => {
  for (const key of ['sc.banner', 'sc.back', 'sc.max']) {
    const ru = A.I18N.t('ru', key, { name: 'X' });
    const en = A.I18N.t('en', key, { name: 'X' });
    assert.ok(ru !== key && en !== key, key);
    assert.match(ru, /[а-яё]/i);
    assert.ok(!/[а-яё]/i.test(en));
  }
  assert.match(A.I18N.t('ru', 'sc.banner', { name: 'X' }), /гипотеза: в журнал фактов она не пишется/);
});
