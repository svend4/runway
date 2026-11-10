// where_money.test.mjs — FP-28: карточка «Куда делись деньги» (сходится с остатком), «следующее списание из конверта» в карточке налога (engine/tax.next_release)
// и контекстные кнопки «Спросить ассистента» (заготовка вопроса в поле «Ассистента», вопрос сам не отправляется; разбор заготовок ассистентом A0 на RU и EN).
// Модель where_money_model — чистая; экран — настоящий app.mjs на заглушке DOM (tests/dom_boot.mjs). Расчёт по введённым данным и правилам, не консультация.
// Браузер и серверы не запускаются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { make_rng } from './helpers.mjs';
import { boot_app, find_all, N } from './dom_boot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const A = await boot_app(); // заглушка DOM и запуск страницы — до первого импорта app.mjs (иначе boot() не сработает)
const WM = await imp('demo/where_money.mjs');
const APP = await imp('demo/app.mjs');
const { safe_to_spend, next_release, format_date, parse_date } = await imp('engine/index.mjs');
const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const SETS = { g001: load('g001.json'), low: load('g001-low.json'), gap: load('g001-gap.json'), late: load('g001-late.json'), debt: load('g001-debt.json') };
const MODES = ['plan', 'worse'];

// ── 1. модель: сумма статей равна остатку ───────────────────────────────────────────────────────────────────────────

test('FP-28 «куда делись деньги»: на всех наборах G-001 и в обоих режимах резервы + платежи + буфер + свободно = остаток на счетах, а «свободно» = «можно потратить» или минус «не хватает до буфера»', () => {
  for (const [name, ws] of Object.entries(SETS)) {
    const model = APP.build_model(ws, { lang: 'ru' });
    for (const mode of MODES) {
      const w = WM.where_money_model(model, mode);
      assert.notEqual(w, null, `${name}/${mode}`);
      assert.equal(w.rows.map((r) => r.id).join(), 'reserves,payments,buffer,free');
      assert.equal(w.rows.reduce((s, r) => s + r.v, 0), model.ctx.series[mode].opening_minor, `${name}/${mode}: сумма статей = остаток на счетах`);
      assert.equal(w.total_minor, w.opening_minor);
      assert.equal(w.ok, true);
      const sts = safe_to_spend(model.ctx, w.T, null, mode);
      const free = w.rows.find((r) => r.id === 'free').v;
      assert.equal(free, sts.min_free - model.ctx.buffer_minor, `${name}/${mode}: свободно = минимум свободных − буфер`);
      assert.equal(free, sts.sts > 0 || sts.short_to_buffer === 0 ? sts.sts : -sts.short_to_buffer, `${name}/${mode}: совпадает с числом «можно потратить» / «не хватает до буфера» на «Обзоре»`);
      assert.equal(w.rows.find((r) => r.id === 'buffer').v, model.ctx.buffer_minor);
      assert.ok(w.rows.find((r) => r.id === 'reserves').v >= 0, 'резервы не отрицательны');
    }
  }
});

test('FP-28 «куда делись деньги» G-001: «если хуже» — 4 000,00 € = 1 120,00 € резервов + 2 170,00 € платежей до 14 ноября + 500,00 € буфера + 210,00 € свободно; «по плану» к 19 ноября', () => {
  const model = APP.build_model(SETS.g001, { lang: 'ru' });
  const worse = WM.where_money_model(model, 'worse');
  assert.deepEqual(worse.rows.map((r) => r.v), [112000, 217000, 50000, 21000]);
  assert.equal(worse.opening_minor, 400000);
  assert.equal(format_date(worse.T), '2026-11-19');
  assert.equal(format_date(worse.at), '2026-11-14');
  assert.equal(worse.sts_minor, 21000, 'то же число, что «можно потратить» в режиме «если хуже»');
  const plan = WM.where_money_model(model, 'plan');
  assert.equal(plan.sts_minor, 43500);
  assert.equal(plan.rows.find((r) => r.id === 'free').v, 43500);
  assert.equal(plan.rows.reduce((s, r) => s + r.v, 0), 400000);
});

test('FP-28 «куда делись деньги»: тождество держится при любых буферах, датах T и в обоих режимах (500 случайных наборов параметров); при нехватке «свободно» отрицательно', () => {
  const rng = make_rng(2801);
  let negative = 0;
  for (let c = 0; c < 500; c++) {
    const base = [SETS.g001, SETS.late, SETS.gap, SETS.low][c % 4];
    const ws = { ...base, params: { ...base.params, buffer_minor: rng.int(0, 400000) } };
    const model = APP.build_model(ws, { lang: 'ru' });
    const a = model.ctx;
    const T = a.as_of + rng.int(0, a.horizon_end - a.as_of);
    const mode = rng.pick(MODES);
    const w = WM.where_money_model(model, mode, T);
    assert.notEqual(w, null);
    assert.equal(w.rows.reduce((s, r) => s + r.v, 0), a.series[mode].opening_minor, `c=${c}`);
    assert.equal(w.ok, true);
    if (w.rows[3].v < 0) negative++;
  }
  assert.ok(negative > 50, 'отрицательное «свободно» встречается: ' + negative);
});

test('FP-28 «куда делись деньги»: гейт тот же, что у «можно потратить» — без буфера и на пустом наборе карточки нет (модель null)', () => {
  const no_buffer = APP.build_model({ ...SETS.g001, params: { ...SETS.g001.params, buffer_minor: null } }, { lang: 'ru' });
  assert.equal(WM.where_money_model(no_buffer, 'worse'), null);
  assert.equal(WM.where_money_model(null, 'worse'), null);
  assert.equal(WM.where_money_model({}, 'worse'), null);
});

// ── 2. экран ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const ctx = A.ext.ctx;
const T = (key, params) => N(A.I18N.t(ctx.lang(), key, params));
const text = () => A.text_of('main');
const click = (n) => n.listeners.click[0]({ preventDefault() {}, target: n });
const card = () => find_all(A.main(), (n) => n.tagName === 'section' && /(^|\s)feedx-where(\s|$)/.test(n.className));
const buttons = (root, label) => find_all(root, (n) => n.tagName === 'button' && N(n.textContent) === label);

await A.go('#overview');

test('FP-28 экран «Обзор» G-001: карточка «Куда делись деньги» одна, четыре статьи и итог = остатку, слова «сходится»; числа те же, что в «как посчитано»', () => {
  const c = card();
  assert.equal(c.length, 1);
  const t = N(c[0].textContent);
  for (const part of ['Куда делись деньги', 'Остаток на 4 октября — 4 000,00 €. К 14 ноября (режим «если хуже») он складывается так:', 'Отложено в резервы1 120,00 €', 'Платежи до 14 ноября за вычетом поступлений2 170,00 €', 'Буфер500,00 €', 'Свободно210,00 €', 'Остаток на 4 октября4 000,00 €', 'Сходится: сумма статей 4 000,00 € равна остатку 4 000,00 €.']) assert.ok(t.includes(part), part + ' // ' + t);
  assert.ok(text().includes('Свободно210,00 €') || text().includes('210,00 €'));
  assert.equal(find_all(c[0], (n) => n.tagName === 'table').length, 1);
  assert.equal(find_all(c[0], (n) => n.tagName === 'caption').length, 1, 'у таблицы есть подпись для скринридера');
});

test('FP-28 экран «Обзор»: режим страницы меняет карточку; на английском подписи и числа в формате языка; при нехватке строка называется «не хватает до буфера» и отрицательна', async () => {
  await A.choose_dataset('gap');
  await A.go('#overview');
  const t = N(card()[0].textContent);
  assert.ok(t.includes('Не хватает до буфера−2 790,00 €'), t);
  assert.ok(!t.includes('Свободно'), 'строки «Свободно» при нехватке нет');
  assert.ok(t.includes('Сходится: сумма статей 1 000,00 € равна остатку 1 000,00 €.'));
  A.set_lang('en');
  await A.go('#overview');
  const en = N(card()[0].textContent);
  assert.ok(en.includes('Where the money went') && en.includes('Short of the buffer−€2,790.00') && en.includes('It adds up: the items sum to €1,000.00, equal to the balance €1,000.00.'), en);
  A.set_lang('ru');
  await A.choose_dataset('g001');
  await A.go('#overview');
  assert.equal(card().length, 1);
});

test('FP-28 экран «Обзор»: пустой набор — карточки нет; кнопка «Как посчитано» в карточке открывает разложение «можно потратить» с теми же числами', async () => {
  await A.choose_dataset('empty');
  await A.go('#overview');
  assert.equal(card().length, 0);
  await A.choose_dataset('g001');
  await A.go('#overview');
  click(buttons(card()[0], 'Как посчитано')[0]);
  assert.equal(A.byid.get('dlg').open, true);
  assert.ok(A.text_of('dlg-body').includes('210,00 €'), A.text_of('dlg-body'));
});

// ── 3. карточка налога: следующее списание из конверта ───────────────────────────────────────────────────────────────

test('FP-28 карточка налога: next_release — ближайшее списание, платёж, часть из конверта и часть сверх него (G-001: платёж 500,00 € 23 октября целиком из конверта 1 500,00 €)', async () => {
  const model = APP.build_model(SETS.g001, { lang: 'ru' });
  const rm = APP.reserves_model(model, 'worse');
  assert.equal(format_date(rm.next_release.date), '2026-10-23');
  assert.deepEqual([rm.next_release.payment_minor, rm.next_release.released_minor, rm.next_release.true_up_minor], [50000, 50000, 0]);
  const direct = next_release('RES-TAX', model.ctx.reserve.worse, model.ctx.events.worse, model.ctx.as_of);
  assert.deepEqual(rm.next_release, direct, 'модель берёт ровно значение движка');
  await A.go('#reserves');
  assert.ok(text().includes('Следующее списание из конверта: 23 октября — платёж 500,00 € целиком из конверта.'), text().slice(0, 1200));
  // платёж больше накопленного: часть из конверта, часть сверх него
  const ws = ctx.get_ws();
  const big = { ...ws, plans: ws.plans.map((p) => (p.plan_id === 'P-TAX1' ? { ...p, amount_minor: -200000 } : p)) };
  assert.equal(ctx.set_ws(big, { reason: 'test' }).ok, true);
  await A.go('#reserves');
  assert.ok(text().includes('Следующее списание из конверта: 23 октября — платёж 2 000,00 €, из конверта 1 500,00 €, сверх конверта 500,00 €.'), text().slice(0, 1400));
  A.set_lang('en');
  await A.go('#reserves');
  assert.ok(text().includes('Next withdrawal from the envelope: October 23 — payment €2,000.00, €1,500.00 from the envelope, €500.00 beyond it.'), text().slice(0, 1400));
  A.set_lang('ru');
  // без налогового резерва строки нет и модель не падает
  const none = { ...SETS.g001, plans: SETS.g001.plans.map((p) => ({ ...p, reserve_id: undefined })) };
  delete none.plans[0].reserve_id;
  assert.equal(APP.reserves_model(APP.build_model(none, { lang: 'ru' }), 'worse').next_release, null);
  await A.choose_dataset('g001');
});

// ── 4. «Спросить ассистента» ─────────────────────────────────────────────────────────────────────────────────────────

const input_value = () => find_all(A.main(), (n) => n.attrs.id === 'as-q')[0]?.value;
const chat_len = () => find_all(A.main(), (n) => n.className === 'msg').length;

test('FP-28 «Спросить ассистента»: на карточках «Обзора» есть кнопки (узкая точка, «хватит ли», «можно потратить», «куда делись деньги»); нажатие открывает «Ассистент» с заготовкой, вопрос не отправляется', async () => {
  await A.go('#overview');
  const asks = buttons(A.main(), 'Спросить ассистента');
  assert.equal(asks.length, 4, 'четыре карточки Обзора');
  assert.deepEqual(asks.map((b) => N(b.attrs['aria-label'])), [
    'Спросить ассистента: узкая точка', 'Спросить ассистента: хватит ли денег', 'Спросить ассистента: можно потратить', 'Спросить ассистента: Куда делись деньги']);
  click(asks[0]);
  assert.equal(location.hash, '#assistant');
  assert.equal(input_value(), 'почему', 'заготовка в поле');
  assert.equal(chat_len(), 0, 'вопрос не отправлен');
  assert.ok(text().includes(T('as.title')));
  // отправка очищает заготовку, ответ приходит от ассистента
  const form = find_all(A.main(), (n) => n.tagName === 'form')[0];
  form.listeners.submit[0]({ preventDefault() {} });
  assert.equal(chat_len(), 1);
  assert.equal(input_value(), '', 'поле очищено');
  // уход с экрана снимает заготовку: возвращение — пустое поле
  await A.go('#overview');
  click(buttons(A.main(), 'Спросить ассистента')[2]);
  assert.equal(input_value(), 'максимум на 2026-11-19');
  await A.go('#feed');
  await A.go('#assistant');
  assert.equal(input_value(), '', 'после ухода заготовка снята');
});

test('FP-28 «Спросить ассистента»: заготовки понятны разбору A0 на RU и EN — почему, прогноз до даты, максимум на дату, налог, когда сумма; ответ ассистента — по инструменту движка', async () => {
  const info = { as_of: '2026-10-04', horizon_end: '2026-11-30', currency: 'EUR', income_ref: 'S-HOURLY@2026-11-05' };
  for (const l of ['ru', 'en']) {
    const q = (key, p) => N(A.I18N.t(l, key, p));
    const cases = [[q('as.q_why'), 'explain_min_point'], [q('as.q_until', { date: '2026-11-30' }), 'get_projection'], [q('as.q_max', { date: '2026-11-19' }), 'max_purchase_amount'],
      [q('as.q_tax'), 'get_tax_envelope'], [q('as.q_when', { amount: '300.00' }), 'earliest_safe_date']];
    for (const [question, tool] of cases) {
      const p = APP.parse_assistant_command(question, info);
      assert.equal(p.ok, true, `${l}: «${question}» → ${JSON.stringify(p)}`);
      assert.equal(p.command.name, tool, `${l}: «${question}»`);
    }
    const when = APP.parse_assistant_command(q('as.q_when', { amount: '300.00' }), info);
    assert.equal(when.command.args.amount_minor, 30000, l + ': сумма из заготовки разобрана точно');
    const until = APP.parse_assistant_command(q('as.q_until', { date: '2026-11-30' }), info);
    assert.equal(until.command.args.to, '2026-11-30');
  }
  const model = APP.build_model(SETS.g001, { lang: 'ru' });
  const r = APP.ask_a0(model, 'когда 300.00', 'ru', 'S-HOURLY@2026-11-05');
  assert.equal(r.ok, true);
  assert.equal(r.verified, true, 'числа ответа сверены верификатором');
});

test('FP-28 «Спросить ассистента» на «Резервах» (карточка налога) и «Купить» (ответ): заготовки «налог» и «когда <сумма>»; сумма в формате без разделителей тысяч', async () => {
  await A.go('#reserves');
  const tax_ask = buttons(A.main(), 'Спросить ассистента');
  assert.ok(tax_ask.some((b) => N(b.attrs['aria-label']) === 'Спросить ассистента: налоговый конверт'));
  click(tax_ask.find((b) => N(b.attrs['aria-label']) === 'Спросить ассистента: налоговый конверт'));
  assert.equal(input_value(), 'налог');
  await A.go('#buy');
  const amount = find_all(A.main(), (n) => n.attrs.id === 'buy-amount')[0];
  amount.value = '1 234,50';
  amount.listeners.input[0]({ target: amount });
  const buy_ask = buttons(A.main(), 'Спросить ассистента').find((b) => N(b.attrs['aria-label']) === 'Спросить ассистента: когда можно купить');
  assert.ok(buy_ask !== undefined, 'кнопка у ответа');
  click(buy_ask);
  assert.equal(input_value(), 'когда 1234.50');
  A.set_lang('en');
  await A.go('#overview');
  click(buttons(A.main(), 'Ask the assistant')[1]);
  assert.equal(input_value(), 'forecast until ' + format_date(parse_date('2026-11-30')));
  A.set_lang('ru');
});

test('FP-28 ctx.ask: пакет просит страницу открыть «Ассистент»; без страницы — false, не строка — false', async () => {
  assert.equal(ctx.ask('почему'), true);
  assert.equal(input_value(), 'почему');
  assert.equal(ctx.ask(42), false);
  const { create_ext } = await imp('demo/ext.mjs');
  const bare = create_ext();
  assert.equal(bare.ctx.ask('почему'), false, 'хозяин не умеет — false');
});

// ── 5. после проверки: «сходится» — настоящая проверка, дата T карточки ──────────────────────────────────────────────────

test('FP-28 «куда делись деньги»: «Сходится» не тождество — подмена строки разложения, остатка или числа «можно потратить» делает проверку ложной; на настоящих данных она истинна', () => {
  for (const [name, ws] of Object.entries(SETS)) {
    const model = APP.build_model(ws, { lang: 'ru' });
    for (const mode of MODES) {
      const w = WM.where_money_model(model, mode);
      assert.equal(WM.where_money_check(w.rows, w.detail, w.opening_minor, w.sts_minor, w.short_to_buffer_minor), true, `${name}/${mode}`);
      assert.deepEqual(WM.where_money_rows(w.detail), w.rows, 'статьи — перестановка строк разложения');
      // платёж в разложении разошёлся на 1 цент: сумма статей всё равно равна «остатку по разложению» (алгебра), но «свободно» уже не равно «можно потратить»
      const bent = w.detail.map((r) => (r.id === 'payments' ? { ...r, v: r.v + 1 } : r));
      const bent_rows = WM.where_money_rows(bent);
      assert.equal(bent_rows.reduce((s, r) => s + r.v, 0), w.opening_minor, 'тождество самой суммы не замечает подмены — поэтому проверки одной суммы мало');
      assert.equal(WM.where_money_check(bent_rows, bent, w.opening_minor, w.sts_minor, w.short_to_buffer_minor), false, `${name}/${mode}: подмена платежа поймана`);
      // строка «остаток» разложения не совпала с остатком из ряда движка
      const bent_open = w.detail.map((r) => (r.id === 'opening' ? { ...r, v: r.v + 1 } : r));
      assert.equal(WM.where_money_check(WM.where_money_rows(bent_open), bent_open, w.opening_minor, w.sts_minor, w.short_to_buffer_minor), false, `${name}/${mode}: подмена остатка поймана`);
      assert.equal(WM.where_money_check(w.rows, w.detail, w.opening_minor + 1, w.sts_minor, w.short_to_buffer_minor), false, 'остаток из ряда движка другой');
      // число «можно потратить» на «Обзоре» другое
      assert.equal(WM.where_money_check(w.rows, w.detail, w.opening_minor, w.sts_minor + 1, w.short_to_buffer_minor), false, 'число «можно потратить» другое');
      assert.equal(WM.where_money_check(w.rows, w.detail, w.opening_minor, w.sts_minor, w.short_to_buffer_minor + 1), false, 'число «не хватает до буфера» другое');
    }
  }
});

test('FP-28 «куда делись деньги»: дата T вне горизонта зажимается к его границам (как на «Обзоре»), карточка не пропадает', () => {
  const model = APP.build_model(SETS.g001, { lang: 'ru' });
  const a = model.ctx;
  assert.equal(WM.where_money_model(model, 'plan', a.horizon_end + 50).T, a.horizon_end);
  assert.equal(WM.where_money_model(model, 'plan', format_date(a.horizon_end + 50)).T, a.horizon_end);
  assert.equal(WM.where_money_model(model, 'plan', a.as_of - 5).T, a.as_of);
  assert.equal(WM.where_money_model(model, 'plan', a.as_of + 3).T, a.as_of + 3);
});

test('FP-28 «куда делись деньги»: карточка раскладывает на дату из поля «Можно потратить · до даты» и называет её; «Свободно» равно числу в блоке «Можно потратить» на эту дату', async () => {
  await A.choose_dataset('g001');
  A.set_lang('ru');
  await A.go('#overview');
  const model = ctx.get_model();
  const mode = ctx.mode();
  const money = (m) => N(new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(m / 100)) + ' €';
  assert.ok(N(card()[0].textContent).includes('Дата расчёта — 19 ноября'), 'по умолчанию — дата блока «Можно потратить» (19 ноября): ' + N(card()[0].textContent).slice(0, 400));
  const seen = new Set();
  for (const [iso, shown] of [['2026-10-25', '25 октября'], ['2026-11-05', '5 ноября'], ['2026-11-30', '30 ноября']]) {
    const input = find_all(A.main(), (n) => n.attrs.id === 'sts-date')[0];
    input.value = iso;
    input.listeners.change[0]({ target: input });
    await A.go('#overview'); // карточка пересчитывается при открытии экрана
    const t = N(card()[0].textContent);
    const want = safe_to_spend(model.ctx, parse_date(iso), null, mode);
    const free = want.sts > 0 || want.short_to_buffer === 0 ? want.sts : -want.short_to_buffer;
    assert.ok(t.includes('Дата расчёта — ' + shown + ' ('), t.slice(0, 300));
    seen.add(free);
    assert.equal(WM.where_money_model(model, mode, iso).rows[3].v, free, iso + ': модель на выбранную дату');
    assert.ok(t.includes(free >= 0 ? 'Свободно' + money(free) : 'Не хватает до буфера' + money(free).replace('-', '−')), `${iso}: «${t.slice(0, 500)}»`);
    // тот же день называет блок «Можно потратить»: число в нём — то же самое
    if (want.sts > 0) assert.ok(text().includes(money(want.sts)), `${iso}: в блоке «Можно потратить» есть ${money(want.sts)}`);
  }
  assert.ok(seen.size > 1, 'выбранная дата действительно меняет «Свободно»: ' + [...seen].join());
  A.set_lang('en');
  await A.go('#overview');
  assert.ok(N(card()[0].textContent).includes('Calculation date: '), N(card()[0].textContent).slice(0, 300));
  A.set_lang('ru');
  await A.choose_dataset('g001'); // выбор набора сбрасывает дату поля
  await A.go('#overview');
  assert.ok(N(card()[0].textContent).includes('Дата расчёта — 19 ноября'));
});

test('FP-28 «куда делись деньги»: чужое или нечитаемое описание места вызова (не объект, нет даты, мусор) не убирает карточку — берётся дата по умолчанию', async () => {
  await A.go('#overview');
  for (const info of [undefined, null, 42, 'x', {}, { sts_t: 5 }, { sts_t: '' }, { sts_t: 'не дата' }]) {
    const node = WM.render_where_money(ctx, info);
    assert.ok(node !== null, JSON.stringify(info));
    assert.ok(N(node.textContent).includes('Дата расчёта — 19 ноября'), JSON.stringify(info));
  }
});
