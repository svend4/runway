// fp26_adv.test.mjs — состязательная проверка FP-26 (независимый проверяющий): то, что тесты реализатора не доказывают.
//   1) фраза ползунка графика сверена с рядом движка НЕЗАВИСИМЫМ путём (свои названия месяцев, свои разряды, дата через Date.UTC): все дни горизонта, оба режима, RU и EN, наборы G-001/gap;
//   2) граница года: при горизонте 120 дней фраза называет год («2 января 2027 года»);
//   3) spoken_money: цифры строки форматтера не теряются и не добавляются при любом пресете формата чисел, знаке и валюте; знаков валют и «−» в фразе нет;
//   4) группа «Ещё»: многократный переход через границу окна не копит подписок и не ломает порядок; matchMedia, бросающий исключение, не роняет навигацию;
//   5) бывшие известные пробелы закрыты исправлением: фокус после «Вернуться к базе», «Открыть как вид», «Убрать» (хранитель focus_keep), Escape после нажатия на ссылку текущего раздела.
// Браузер, сеть и серверы не запускаются. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot_app, find_all, N, DEMO, Node_ } from './dom_boot.mjs';

const SP = await import(pathToFileURL(path.join(DEMO, 'speech.mjs')).href);
const NF = await import(pathToFileURL(path.join(DEMO, 'number_format.mjs')).href);

const A = await boot_app({ raf: true });

const RU_M = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const EN_M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso_of = (epoch_day) => new Date(epoch_day * 86400000).toISOString().slice(0, 10);
const group = (s, sep) => s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
const words_of = (lang, minor) => {
  const abs = Math.abs(minor);
  const frac = String(abs % 100).padStart(2, '0');
  const whole = String(Math.floor(abs / 100));
  return { neg: minor < 0, num: lang === 'ru' ? group(whole, ' ') + ',' + frac : group(whole, ',') + '.' + frac };
};
const pick_mode = (mode) => {
  const seg = find_all(A.controls(), (n) => n.tagName === 'div' && n.className === 'seg')[0];
  A.click(seg.children[mode === 'plan' ? 0 : 1]);
};

/** Сверить фразу ползунка с рядом движка для всех дней; вернуть список расхождений. */
function check_slider(ds, lang, mode) {
  const model = A.ext.ctx.get_model();
  const as_of_year = iso_of(model.ctx.as_of).slice(0, 4);
  const series = model.ctx.series[mode];
  const day = A.by_id('chart-day');
  const bad = [];
  for (let i = 0; i < series.close.length; i += 1) {
    day.value = String(i);
    day.listeners.input[0]();
    const got = N(day.attrs['aria-valuetext']);
    const [y, mo, dd] = iso_of(series.from + i).split('-').map(Number);
    const tail_ru = String(y) === as_of_year ? '' : ` ${y} года`;
    const tail_en = String(y) === as_of_year ? '' : `, ${y}`;
    const date_w = lang === 'ru' ? `${dd} ${RU_M[mo - 1]}${tail_ru}` : `${EN_M[mo - 1]} ${dd}${tail_en}`;
    const w = words_of(lang, series.close[i]);
    const want = lang === 'ru'
      ? `остаток ${date_w} ${w.neg ? 'минус ' : ''}${w.num} евро`
      : `balance on ${date_w}: ${w.neg ? 'minus ' : ''}${w.num} euros`;
    if (got !== want) bad.push({ ds, lang, mode, i, got, want });
  }
  return bad;
}

test('FP-26 adv: фраза ползунка совпадает с рядом движка во все дни горизонта — G-001 и «не хватает», plan и worse, RU и EN (независимая сверка: даты, разряды, «минус»)', async () => {
  let days = 0;
  const bad = [];
  for (const ds of ['g001', 'gap']) {
    await A.choose_dataset(ds);
    await A.go('#overview');
    for (const lang of ['ru', 'en']) {
      A.set_lang(lang);
      for (const mode of ['plan', 'worse']) {
        pick_mode(mode);
        assert.equal(A.ext.ctx.mode(), mode);
        days += A.ext.ctx.get_model().ctx.series[mode].close.length;
        bad.push(...check_slider(ds, lang, mode));
      }
    }
  }
  pick_mode('plan');
  A.set_lang('ru');
  assert.ok(days >= 4 * 58 * 2, 'проверено дней: ' + days);
  assert.deepEqual(bad.slice(0, 5), []);
});

test('FP-26 adv: граница года — при горизонте 120 дней фраза называет год (RU «2 января 2027 года», EN «January 2, 2027»), 31 октября по-прежнему без года', async () => {
  await A.choose_dataset('g001');
  const ws = structuredClone(A.ext.ctx.get_ws());
  ws.params = { ...(ws.params ?? {}), horizon_days: 120 };
  assert.equal(A.ext.ctx.adopt(ws, { source: 'test' }).ok, true);
  A.set_lang('ru');
  await A.go('#overview');
  pick_mode('plan'); // по умолчанию режим «если хуже» (D-04): ряд сверяется с тем режимом, который выбран на странице
  assert.equal(A.ext.ctx.mode(), 'plan');
  assert.equal(A.ext.ctx.get_model().ctx.series.plan.close.length, 121);
  assert.deepEqual(check_slider('g001-120', 'ru', 'plan'), []);
  const at = (i) => { const day = A.by_id('chart-day'); day.value = String(i); day.listeners.input[0](); return N(day.attrs['aria-valuetext']); };
  assert.equal(at(27), 'остаток 31 октября 2 055,00 евро');
  assert.match(at(90), /^остаток 2 января 2027 года /);
  A.set_lang('en');
  assert.deepEqual(check_slider('g001-120', 'en', 'plan'), []);
  assert.match(at(90), /^balance on January 2, 2027: /);
  A.set_lang('ru');
  await A.choose_dataset('g001');
  await A.go('#overview');
});

test('FP-26 adv: spoken_money не теряет и не добавляет цифры при любом пресете формата чисел, знаке и валюте; знаков валют, «−» и двойных пробелов нет', () => {
  const presets = [null, { decimal: ',', thousands: ' ' }, { decimal: '.', thousands: ',' }, { decimal: ',', thousands: '.' }, { decimal: '.', thousands: '' }, { decimal: ',', thousands: '' }];
  const amounts = [0, 1, 99, 100, 101, 1100, 11100, 123456, -1, -100, -123456789, 99999999999];
  const bad = [];
  let n = 0;
  for (const lang of ['ru', 'en']) for (const cur of ['EUR', 'USD', 'GBP', 'RUB', 'CHF', 'PLN']) for (const nf of presets) for (const minor of amounts) {
    const formatted = NF.make_nf_fmt(lang, cur, '2026-10-04', nf).money(minor);
    const s = N(SP.spoken_money(lang, minor, cur, formatted));
    n += 1;
    if (formatted.replace(/\D/g, '') !== s.replace(/\D/g, '')) bad.push(['цифры', lang, cur, nf, minor, formatted, s]);
    if (/[€$£₽−]/.test(s)) bad.push(['знак', lang, cur, nf, minor, formatted, s]);
    if ((minor < 0) !== /минус|minus/.test(s)) bad.push(['минус', lang, cur, nf, minor, formatted, s]);
    if (/\s{2,}/.test(s)) bad.push(['пробелы', lang, cur, nf, minor, formatted, s]);
  }
  assert.ok(n > 800, 'комбинаций: ' + n);
  assert.deepEqual(bad.slice(0, 5), []);
});

test('FP-26 adv: группа «Ещё» — многократный переход через границу окна не копит подписок и оставляет порядок вкладки → «Ещё» → действия; сломанный matchMedia возвращает прежние списки', async () => {
  await A.set_phone(true);
  const subs_before = A.media.subs.length;
  assert.ok(subs_before >= 1);
  for (let i = 0; i < 6; i += 1) { await A.set_phone(false); await A.set_phone(true); }
  assert.equal(A.media.subs.length, subs_before, 'подписчиков на изменение ширины не прибавилось');
  assert.deepEqual(A.nav().children.map((k) => k.tagName), ['ul', 'details', 'ul']);
  const ids = find_all(A.nav(), (n) => n.attrs.id !== undefined).map((n) => n.attrs.id);
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы в панели уникальны');
  const real = globalThis.window.matchMedia;
  globalThis.window.matchMedia = () => { throw new Error('matchMedia недоступен'); };
  try {
    A.ext.ctx.refresh();
    assert.deepEqual(A.nav().children.map((k) => k.tagName + '.' + k.className), ['ul.nav-sections', 'ul.nav-actions'], 'без matchMedia — прежние два списка S1.4');
  } finally {
    globalThis.window.matchMedia = real;
  }
  A.ext.ctx.refresh();
  assert.deepEqual(A.nav().children.map((k) => k.tagName), ['ul', 'details', 'ul']);
  await A.set_phone(false);
});

// Бывшие известные пробелы (были test.todo) — закрыты исправлением после проверки FP-26; тесты ниже их закрепляют.
// «Открыть как вид» оставляет фокус на той же кнопке (новый узел), «Вернуться к базе» и «Убрать» отдают его заголовку экрана, чужой фокус не отбирается.
test('FP-26 adv: «Вернуться к базе» убирает кнопку из страницы — фокус должен вернуться хранителем focus_keep (раньше оставался на body; урок 10)', async () => {
  A.emulate_focus_loss(true); // как в браузере: убранный из страницы узел роняет фокус на body
  try {
    A.set_lang('ru');
    await A.choose_dataset('g001');
    await A.go('#scenarios');
    const T = (key, params) => N(A.I18N.t('ru', key, params));
    const delay7 = find_all(A.main(), (n) => n.tagName === 'button' && n.className === 'chip' && N(n.textContent) === T('sc.chip_delay', { n: 7, days: A.I18N.word_form('ru', 'day', 7) }))[0];
    A.click(delay7);
    const by_id = (id) => find_all(A.main(), (n) => n.attrs.id === id)[0];
    const apply = by_id('sc-apply-1');
    assert.ok(apply !== undefined, 'у кнопки «Открыть как вид» есть идентификатор для хранителя фокуса');
    apply.focus();
    A.click(apply);
    await A.tick();
    const banner = () => find_all(A.summary(), (n) => n.className === 'banner scenario')[0];
    assert.ok(banner() !== undefined);
    assert.equal(document.activeElement.attrs.id, 'sc-apply-1', 'фокус на кнопке «Открыть как вид» (после перерисовки — новый узел)');
    assert.notEqual(document.activeElement, apply, 'это уже новый узел, а не убранный');
    // «Вернуться к базе»: кнопка исчезает вместе с плашкой
    const back = find_all(banner(), (n) => n.tagName === 'button')[0];
    back.focus();
    assert.equal(document.activeElement, back);
    A.click(back);
    await A.tick();
    assert.equal(banner(), undefined, 'плашка снята');
    assert.equal(document.activeElement.attrs.id, 'view-title', 'фокус не упал на body — он на заголовке экрана');
    // «Убрать»: столбец сравнения исчезает; чужой фокус хранитель не отбирает
    const remove = by_id('sc-remove-1');
    remove.focus();
    A.click(remove);
    await A.tick();
    assert.equal(by_id('sc-remove-1'), undefined, 'сценарий убран из сравнения');
    assert.equal(document.activeElement.attrs.id, 'view-title');
    A.click(find_all(A.main(), (n) => n.tagName === 'button' && n.className === 'chip' && N(n.textContent) === T('sc.chip_delay', { n: 14, days: A.I18N.word_form('ru', 'day', 14) }))[0]);
    const other = new Node_('input');
    other.focus();
    const apply2 = by_id('sc-apply-1') ?? by_id('sc-apply-2');
    A.click(apply2);
    other.focus(); // пользователь сам перешёл в другое поле до того, как хранитель сработал
    await A.tick();
    assert.equal(document.activeElement, other, 'чужой фокус не отбирается');
    A.click(find_all(A.summary(), (n) => n.tagName === 'button' && n.className === 'link')[0]); // вернуться к базе
    await A.tick();
    A.click(find_all(A.main(), (n) => n.tagName === 'button' && n.className === 'link' && N(n.textContent) === 'Убрать')[0]);
    await A.tick();
    document.activeElement = document.body;
  } finally {
    A.emulate_focus_loss(false);
  }
});

// Нажатие закрывает сам узел details и возвращает фокус на «Ещё»; Escape смотрит на узел, а не на флаг модуля; нажатие на вкладку фокус с неё не уводит.
test('FP-26 adv: Escape закрывает раскрытое «Ещё» и после нажатия на ссылку текущего раздела (more_open сброшен click-обработчиком, а список закрывается вместе с узлом — Escape работает)', async () => {
  const NM = await import(pathToFileURL(path.join(DEMO, 'nav_more.mjs')).href);
  await A.set_phone(true);
  await A.go('#settings');
  const list_link = () => find_all(A.nav().children[1], (n) => n.tagName === 'a' && n.attrs['aria-current'] === 'page')[0];
  const open_more = () => { const m = A.nav().children[1]; m.open = true; m.listeners.toggle[0](); return m; };
  let more = open_more();
  assert.equal(NM.more_state().open, true, 'флаг модуля отражает раскрытие');
  assert.equal(list_link().attrs.href, '#settings', 'текущий раздел из группы «Ещё»');
  // нажатие на ссылку текущего раздела: hashchange не будет, перерисовки нет — список обязан закрыться сам
  more.children[1].listeners.click[0]({});
  assert.equal(more.open, false, 'узел details закрыт');
  assert.equal(NM.more_state().open, false);
  assert.equal(document.activeElement.attrs.id, 'nav-more-sum', 'фокус — на «Ещё»: свёрнутый список не держит фокус');
  // повторное раскрытие и Escape работают
  more = open_more();
  more.listeners.keydown[0]({ key: 'Escape' });
  assert.equal(more.open, false);
  // рассинхрон «узел раскрыт, флаг сброшен» (событие toggle не дошло): Escape всё равно закрывает
  more.open = true;
  assert.equal(NM.more_state().open, false, 'флаг отстал от узла');
  more.listeners.keydown[0]({ key: 'Escape' });
  assert.equal(more.open, false, 'Escape смотрит на узел');
  assert.equal(document.activeElement.attrs.id, 'nav-more-sum');
  // нажатие на вкладку при раскрытом «Ещё» закрывает список, но фокус с вкладки не уводит (на «Ещё» он уходит только со ссылки внутри списка)
  more = open_more();
  const tab = A.nav().children[0].children[0].children[0];
  tab.focus();
  A.nav().children[0].listeners.click[0]({});
  assert.equal(more.open, false, 'список закрыт');
  assert.equal(document.activeElement, tab, 'фокус остался на нажатой вкладке');
  assert.equal(tab.attrs.id, 'nav-a-overview');
  // служебные экспорты модуля: сброс состояния и доступ к кнопке «Ещё»
  more = open_more();
  assert.equal(NM.more_state().open, true);
  NM.reset_more();
  assert.equal(NM.more_state().open, false, 'reset_more сбрасывает состояние');
  assert.equal(NM.more_button()?.attrs.id, NM.MORE_ID, 'more_button возвращает кнопку «Ещё» из текущей навигации');
  assert.equal(typeof NM.keep_focus_after_render, 'function');
  await A.go('#overview');
  await A.set_phone(false);
});
