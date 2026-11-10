// why_dialogs_full.test.mjs — FP-47, часть 1 (REQ-104, TST-07, TST-56, TST-58): диалоги «Почему» у ПЯТИ ключевых чисел показывают одно и то же содержимое:
// цепочку вкладов, контрфакты («что было бы без…»), режим, версию движка, сокращённый inputs_hash и номер расчёта c_….
// Пять чисел: узкая точка (штатный диалог приложения), вердикт, «можно потратить», волна, ответ ассистента. Хвост прежнего аудита: в диалогах вердикта,
// «можно потратить» и волны не было версии и c_…, а у «можно потратить» и волны — контрфактов; ни один тест этого не проверял.
// Номер расчёта проверяется против НАСТОЯЩЕГО вызова инструмента движка (`run_tool`): тот же `call_id`, а числа диалога совпадают с evidence результата.
// Контрфакты «можно потратить» и волны проверяются независимым путём: пересчёт набора данных без правила (`ws.rules` без R-RENT), а не операцией сценария.
// Расчёт по введённым данным и правилам, не консультация. Браузер, сервер и сеть не используются.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/why_dialogs_full.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot_app, find_all, N, DEMO } from './dom_boot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);

const api = await boot_app();
const E = await imp('engine/index.mjs');
const { make_tool_ctx, run_tool, call_ref } = await imp('engine/tools.mjs');
const W = await imp('demo/why_more.mjs');
const AX = await imp('demo/assistant_ext.mjs');
const SCEN = (await imp('demo/i18n/scenarios.mjs')).default;
const { LABELS } = await imp('engine/verifier.mjs');

const clone = (x) => JSON.parse(JSON.stringify(x));
const read = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name + '.json'), 'utf8'));
const G = read('g001');
const ctx = api.ext.ctx;
const model_of = (ws) => ({ ws, ctx: make_tool_ctx(ws, { as_of: ws.as_of }, {}) });
const MG = model_of(G);
const dlg = () => N(api.byid.get('dlg-body').textContent);
const dlg_title = () => N(api.byid.get('dlg-title').textContent);
const ev_val = (r, id) => r.evidence.find((e) => e.id === id).v;
const day = (iso) => E.to_epoch_day(iso);

/** Номер расчёта настоящего вызова инструмента движка (на свежем контексте, как делает ассистент). */
const real_ref = (tool, args) => {
  const r = run_tool(tool, args, model_of(G).ctx);
  assert.ok(r.isError !== true, tool + ': ' + JSON.stringify(r));
  return { ref: call_ref(r.call_id), result: r };
};

/** Нет ни inline-стилей, ни таблиц без подписи в диалоге. */
function a11y_problems(root) {
  const bad = [];
  root.walk((n) => {
    if (n.attrs.style !== undefined) bad.push('inline style');
    if (n.tagName === 'table' && !n.children.some((c) => c.tagName === 'caption' && c.textContent.trim() !== '')) bad.push('таблица без подписи');
  });
  return bad;
}

const common_checks = (text, ref, label) => {
  assert.ok(text.includes(ref), label + ': номер расчёта ' + ref);
  assert.ok(/c_[0-9a-f]{8}/.test(text), label + ': номер расчёта вида c_… ');
  assert.ok(text.includes(E.ENGINE_VERSION), label + ': версия движка ' + E.ENGINE_VERSION);
  assert.ok(text.includes(MG.ctx.inputs_hash.slice(0, 8)), label + ': сокращённый inputs_hash');
  assert.ok(!/Не сходится|Does not add up|It does not add up/.test(text), label + ': сверка не должна падать');
};

// ── номер расчёта = настоящий вызов инструмента ─────────────────────────────────────────────────────────────────────

test('REQ-104 происхождение числа: номер расчёта c_… равен call_id настоящего вызова инструмента движка, а числа диалога лежат в evidence этого результата', () => {
  for (const mode of ['plan', 'worse']) {
    // вердикт: explain_min_point — та же цепочка, что и у узкой точки
    const v = W.verdict_why(MG, mode);
    const o = W.verdict_origin(MG, mode);
    const real = real_ref('explain_min_point', { mode });
    assert.equal(o.ref, real.ref, mode + ': вердикт');
    assert.equal(o.tool, 'explain_min_point');
    assert.equal(ev_val(real.result, real.result.facts.point.amount_minor), v.point.amount_minor, 'минимум вердикта — в evidence');
    assert.equal(ev_val(real.result, real.result.facts.point.date), E.format_date(v.point.date));
    // «можно потратить»: get_projection до даты T — в фактах sts_minor, min_free, short_to_buffer
    const s = W.sts_why(MG, mode);
    assert.equal(s.gated, false);
    const so = W.sts_origin(MG, mode, s.T);
    const sreal = real_ref('get_projection', { to: E.format_date(s.T), mode });
    assert.equal(so.ref, sreal.ref, mode + ': можно потратить');
    assert.equal(ev_val(sreal.result, sreal.result.facts.sts_minor), s.sts_minor, '«можно потратить» — в evidence');
    assert.equal(ev_val(sreal.result, sreal.result.facts.min_free.amount_minor), s.min_free_minor);
    assert.equal(ev_val(sreal.result, sreal.result.facts.short_to_buffer_minor), s.short_to_buffer_minor);
    // волна: list_waves на весь горизонт — need, cash, gap каждой волны
    const wo = W.wave_origin(MG, mode);
    const wreal = real_ref('list_waves', { from: G.as_of, to: E.format_date(MG.ctx.horizon_end), mode });
    assert.equal(wo.ref, wreal.ref, mode + ': волна');
    const items = E.list_waves_ex(MG.ctx, mode).items;
    assert.equal(wreal.result.facts.waves.length, items.length);
    items.forEach((it, i) => {
      assert.equal(ev_val(wreal.result, wreal.result.facts.waves[i].need), it.metrics.need_minor, 'потребность волны ' + (i + 1));
      assert.equal(ev_val(wreal.result, wreal.result.facts.waves[i].cash), it.metrics.cash_minor);
      assert.equal(ev_val(wreal.result, wreal.result.facts.waves[i].gap), it.metrics.gap_minor);
    });
    for (const x of [o, so, wo]) {
      assert.equal(x.version, E.ENGINE_VERSION);
      assert.equal(x.hash, MG.ctx.inputs_hash.slice(0, 8));
      assert.match(x.ref, /^c_[0-9a-f]{8}$/);
    }
  }
  assert.notEqual(W.sts_origin(MG, 'plan').ref, W.sts_origin(MG, 'worse').ref, 'режим входит в номер расчёта');
  assert.notEqual(W.verdict_origin(MG, 'plan').ref, W.wave_origin(MG, 'plan').ref, 'разные инструменты — разные номера');
});

test('REQ-104 номер расчёта зависит от данных: после правки набора данных номер вердикта меняется, версия остаётся версией движка', () => {
  const ws2 = clone(G);
  const m2 = model_of({ ...ws2, params: { ...ws2.params, buffer_minor: 123456 } });
  assert.notEqual(m2.ctx.inputs_hash, MG.ctx.inputs_hash);
  assert.notEqual(W.verdict_origin(m2, 'worse').ref, W.verdict_origin(MG, 'worse').ref);
  assert.equal(W.verdict_origin(m2, 'worse').version, E.ENGINE_VERSION);
});

// ── число 1: узкая точка (штатный диалог приложения) ─────────────────────────────────────────────────────────────────

test('REQ-104 число 1, узкая точка: штатный диалог — цепочка, контрфакты, режим, версия, hash, c_… и сверка «сходится»', async () => {
  await api.go('#overview');
  const why = find_all(api.main(), (n) => n.tagName === 'button' && n.textContent === 'почему?');
  assert.ok(why.length >= 2);
  for (const [i, mode] of [[0, 'plan'], [1, 'worse']]) {
    why[i].listeners.click[0]();
    const text = dlg_title() + ' ' + dlg();
    const { ref } = real_ref('explain_min_point', { mode });
    common_checks(text, ref, 'узкая точка ' + mode);
    assert.match(text, /Что было бы без/, 'контрфакты');
    assert.match(text, /Сходится: сумма строк/, 'сверка суммы');
    assert.ok(text.includes(LABELS.modes.ru[mode]), 'режим словом');
  }
});

// ── число 2: вердикт ─────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-104 число 2, вердикт: диалог показывает версию движка и номер расчёта c_…, контрфакты и сходящуюся сумму — в обоих режимах и на обоих языках', async () => {
  for (const lang of ['ru', 'en']) {
    api.set_lang(lang);
    await api.tick();
    for (const mode of ['plan', 'worse']) {
      W.open_verdict_why(ctx, mode);
      const text = dlg_title() + ' ' + dlg();
      const { ref } = real_ref('explain_min_point', { mode });
      common_checks(text, ref, lang + ' вердикт ' + mode);
      assert.ok(text.includes(ctx.tr('scenarios.verdict_cf_title')), lang + ': контрфакты');
      assert.ok(text.includes(ctx.tr('scenarios.why_origin', { ref, version: E.ENGINE_VERSION })), lang + ': строка происхождения целиком');
      const v = W.verdict_why(MG, mode);
      assert.equal(v.why.ok, true, 'сумма цепочки равна просадке');
      assert.ok(text.includes(N(ctx.tr('scenarios.why_sum_ok', { sum: ctx.fmt().money(v.why.total_minor), what: ctx.tr('scenarios.why_target_drop'), target: ctx.fmt().money(v.why.drop_minor) }))), lang + ': словесная сверка');
      assert.deepEqual(a11y_problems(api.byid.get('dlg-body')), []);
    }
  }
  api.set_lang('ru');
  await api.tick();
});

// ── число 3: «можно потратить» ───────────────────────────────────────────────────────────────────────────────────────

test('REQ-104 число 3, «можно потратить»: диалог показывает версию, c_… (get_projection) и контрфакты «что было бы без…»; сумма строк равна минимуму свободных минус буфер', async () => {
  for (const lang of ['ru', 'en']) {
    api.set_lang(lang);
    await api.tick();
    for (const mode of ['plan', 'worse']) {
      W.open_sts_why(ctx, mode);
      const text = dlg_title() + ' ' + dlg();
      const s = W.sts_why(MG, mode);
      const { ref } = real_ref('get_projection', { to: E.format_date(s.T), mode });
      common_checks(text, ref, lang + ' можно потратить ' + mode);
      assert.ok(text.includes(ctx.tr('scenarios.verdict_cf_title')), lang + ': заголовок контрфактов');
      const cf = W.sts_counterfactuals(MG, mode, s);
      assert.equal(cf.length, 3, 'три группы платежей на G-001');
      const namer = W.make_event_namer(G, lang);
      for (const c of cf) {
        const row = ctx.tr('scenarios.sts_cf', { name: namer.group(c.group), value: ctx.fmt().money(c.sts_minor), delta: (c.delta_minor > 0 ? '+' : '') + ctx.fmt().money(c.delta_minor) });
        assert.ok(text.includes(N(row)), lang + ' ' + mode + ': строка контрфакта «' + row + '»');
      }
      assert.equal(s.ok, true);
      assert.ok(text.includes(N(ctx.tr('scenarios.why_sum_ok', { sum: ctx.fmt().money(s.total_minor), what: ctx.tr('scenarios.why_target_sts'), target: ctx.fmt().money(s.min_free_minor - (s.buffer_minor ?? 0)) }))), lang + ': сверка суммы');
      assert.deepEqual(a11y_problems(api.byid.get('dlg-body')), []);
    }
  }
  api.set_lang('ru');
  await api.tick();
});

test('REQ-104 контрфакты «можно потратить» совпадают с независимым пересчётом набора данных без правила: аренда убрана — «можно потратить» выше на 900,00 € по плану', () => {
  for (const mode of ['plan', 'worse']) {
    const s = W.sts_why(MG, mode);
    const cf = W.sts_counterfactuals(MG, mode, s);
    const rent = cf.find((c) => c.group === 'R-RENT');
    assert.ok(rent !== undefined, mode + ': аренда среди первых трёх групп');
    const ws2 = clone(G);
    ws2.rules = ws2.rules.filter((r) => r.rule_id !== 'R-RENT'); // независимый путь: правило удалено из данных, а не событие убрано сценарием
    const a2 = E.analyze(ws2, { as_of: ws2.as_of });
    const s2 = E.safe_to_spend(a2, s.T, null, mode);
    assert.equal(rent.sts_minor, s2.sts, mode + ': «можно потратить» без аренды');
    assert.equal(rent.delta_minor, s2.sts - s.sts_minor);
    assert.ok(rent.delta_minor > 0, 'без платежа можно потратить больше');
  }
  const plan = W.sts_counterfactuals(MG, 'plan', W.sts_why(MG, 'plan'));
  assert.equal(plan.find((c) => c.group === 'R-RENT').delta_minor, 90000, 'канон G-001: аренда 900,00 €');
});

test('REQ-104 налоговый платёж, оплаченный из резерва, не меняет «можно потратить»: контрфакт честно показывает 0, а не выдуманный выигрыш', () => {
  const s = W.sts_why(MG, 'plan');
  const tax = W.sts_counterfactuals(MG, 'plan', s).find((c) => c.group.startsWith('tag:'));
  assert.ok(tax !== undefined);
  assert.equal(tax.delta_minor, 0, 'платёж из резерва: свободные деньги те же');
});

// ── число 4: волна ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-104 число 4, волна: диалог показывает версию, c_… (list_waves) и контрфакты потребности; сумма строк равна пиковой просадке окна — для каждой волны, режима и языка', async () => {
  for (const lang of ['ru', 'en']) {
    api.set_lang(lang);
    await api.tick();
    for (const mode of ['plan', 'worse']) {
      const items = E.list_waves_ex(MG.ctx, mode).items;
      assert.equal(items.length, 2, 'две волны G-001');
      items.forEach((it, i) => {
        W.open_wave_why(ctx, { ...it, n: i + 1, mode }, mode);
        const text = dlg_title() + ' ' + dlg();
        const wave_ref = real_ref('list_waves', { from: G.as_of, to: E.format_date(MG.ctx.horizon_end), mode }).ref;
        common_checks(text, wave_ref, lang + ' волна ' + (i + 1) + ' ' + mode);
        assert.ok(text.includes(ctx.tr('scenarios.verdict_cf_title')), lang + ': заголовок контрфактов');
        const w = W.wave_why(MG, mode, it);
        assert.equal(w.ok, true);
        assert.ok(text.includes(N(ctx.tr('scenarios.why_sum_ok', { sum: ctx.fmt().money(w.total_minor), what: ctx.tr('scenarios.why_target_need'), target: ctx.fmt().money(w.r_minor) }))), lang + ': сверка суммы');
        const cf = W.wave_counterfactuals(MG, mode, it);
        assert.ok(cf.length >= 1 && cf.length <= 3, 'контрфакты волны');
        const namer = W.make_event_namer(G, lang);
        for (const c of cf) {
          const row = ctx.tr('scenarios.wave_cf', { name: namer.group(c.group), need: ctx.fmt().money(c.need_minor), delta: (c.delta_minor > 0 ? '+' : '') + ctx.fmt().money(c.delta_minor), gap: ctx.fmt().money(c.gap_minor) });
          assert.ok(text.includes(N(row)), lang + ': строка контрфакта «' + row + '»');
        }
        assert.deepEqual(a11y_problems(api.byid.get('dlg-body')), []);
      });
    }
  }
  api.set_lang('ru');
  await api.tick();
});

test('REQ-104 контрфакты волны: потребность без группы совпадает с независимым пересчётом без правила (окно и состав волны те же); платёж убран — потребность не растёт', () => {
  for (const mode of ['plan', 'worse']) {
    const items = E.list_waves_ex(MG.ctx, mode).items;
    for (const it of items) {
      const cf = W.wave_counterfactuals(MG, mode, it);
      const rent = cf.find((c) => c.group === 'R-RENT');
      if (rent === undefined) continue;
      const ws2 = clone(G);
      ws2.rules = ws2.rules.filter((r) => r.rule_id !== 'R-RENT');
      const a2 = E.analyze(ws2, { as_of: ws2.as_of });
      const m2 = E.wave_metrics(it.wave, a2.series[mode], MG.ctx.buffer_minor ?? 0, E.next_income_day(a2.events[mode], it.wave.end));
      assert.equal(rent.need_minor, m2.need_minor, mode + ' ' + it.wave.wave_id + ': потребность без аренды');
      assert.equal(rent.gap_minor, m2.gap_minor);
      assert.equal(rent.delta_minor, m2.need_minor - it.metrics.need_minor);
    }
    assert.ok(items.some((it) => W.wave_counterfactuals(MG, mode, it).some((c) => c.group === 'R-RENT')), mode + ': аренда есть в контрфактах хотя бы одной волны');
  }
  const wave1 = E.list_waves_ex(MG.ctx, 'plan').items[0];
  const rent1 = W.wave_counterfactuals(MG, 'plan', wave1).find((c) => c.group === 'R-RENT');
  assert.equal(rent1.delta_minor, -90000, 'канон G-001: без аренды потребность волны 1 меньше на 900,00 €');
  assert.ok(W.wave_counterfactuals(MG, 'plan', wave1).every((c) => c.delta_minor <= 0), 'убрать платёж — потребность не растёт');
});

// ── число 5: ответ ассистента ────────────────────────────────────────────────────────────────────────────────────────

test('REQ-104 число 5, ответ ассистента: диалог показывает цепочку, контрфакты, режим, версию, hash и номер расчёта c_… этого ответа', () => {
  api.set_lang('ru');
  const result = run_tool('check_purchase', { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }, model_of(G).ctx);
  assert.ok(result.isError !== true);
  const ref = call_ref(result.call_id);
  assert.equal(ref, 'c_131fba11', 'канон TV-1');
  AX.open_answer_why(ctx, result, ref);
  const text = dlg_title() + ' ' + dlg();
  common_checks(text, ref, 'ответ ассистента');
  assert.match(text, /Что было бы без/, 'контрфакты');
  assert.match(text, /Сходится: сумма строк/);
  assert.ok(text.includes(LABELS.modes.ru.worse), 'режим словом');
});

// ── общие свойства ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-104 пять диалогов: в каждом один и тот же набор — версия движка, c_…, hash, контрфакты, сверка; нет ни одного без номера расчёта', async () => {
  api.set_lang('ru');
  await api.tick();
  const opened = [];
  const grab = (label) => { opened.push([label, dlg_title() + ' ' + dlg()]); };
  await api.go('#overview');
  find_all(api.main(), (n) => n.tagName === 'button' && n.textContent === 'почему?')[1].listeners.click[0](); grab('узкая точка');
  W.open_verdict_why(ctx, 'worse'); grab('вердикт');
  W.open_sts_why(ctx, 'worse'); grab('можно потратить');
  W.open_wave_why(ctx, { ...E.list_waves_ex(MG.ctx, 'worse').items[0], n: 1, mode: 'worse' }, 'worse'); grab('волна');
  AX.open_answer_why(ctx, run_tool('check_purchase', { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }, model_of(G).ctx), 'c_131fba11'); grab('ответ ассистента');
  assert.equal(opened.length, 5);
  for (const [label, text] of opened) {
    assert.ok(/c_[0-9a-f]{8}/.test(text), label + ': есть номер расчёта');
    assert.ok(text.includes(E.ENGINE_VERSION), label + ': есть версия движка');
    assert.ok(text.includes('fc9d650d'), label + ': есть hash');
    assert.ok(/Что было бы без/.test(text), label + ': есть контрфакты');
    assert.ok(/Сходится/.test(text), label + ': сверка сходится');
  }
});

test('REQ-104 если сценарий страницы убирает платёж, контрфакты строятся поверх сценария (не из базовых данных)', () => {
  const ref = MG.ctx.events.plan.find((e) => e.rule_id === 'R-UTIL');
  assert.ok(ref !== undefined);
  const ops = [{ op: 'remove_flow', event_ref: 'R-UTIL' }];
  const ws = clone(G);
  const model = { ws, scenario: { ops }, ctx: make_tool_ctx(ws, { as_of: ws.as_of, scenario: { ops } }, {}) };
  assert.ok(!model.ctx.events.plan.some((e) => e.rule_id === 'R-UTIL'), 'сценарий убрал R-UTIL');
  const s = W.sts_why(model, 'plan');
  const cf = W.sts_counterfactuals(model, 'plan', s);
  assert.ok(cf.length >= 1);
  assert.ok(cf.every((c) => c.group !== 'R-UTIL'), 'убранный сценарием платёж в цепочке не фигурирует');
  const rent = cf.find((c) => c.group === 'R-RENT');
  assert.ok(rent !== undefined);
  const ws2 = clone(G);
  ws2.rules = ws2.rules.filter((r) => r.rule_id !== 'R-RENT' && r.rule_id !== 'R-UTIL');
  const s2 = E.safe_to_spend(E.analyze(ws2, { as_of: ws2.as_of }), s.T, null, 'plan');
  assert.equal(rent.sts_minor, s2.sts, 'без аренды и без коммунальных (сценарий) — как независимый пересчёт');
  assert.notEqual(W.sts_origin(model, 'plan', s.T).ref, W.sts_origin(MG, 'plan').ref, 'с другим сценарием — другой номер расчёта');
});

test('REQ-104 четыре набора G-001: контрфакты «можно потратить» и волны считаются без ошибок, не больше трёх на число, сумма цепочек сходится', () => {
  for (const name of ['g001', 'g001-low', 'g001-gap', 'g001-late']) {
    const ws = read(name);
    const model = model_of(ws);
    for (const mode of ['plan', 'worse']) {
      const s = W.sts_why(model, mode);
      if (!s.gated) {
        assert.equal(s.ok, true, name + ' ' + mode + ': сумма «можно потратить»');
        const cf = W.sts_counterfactuals(model, mode, s);
        assert.ok(cf.length <= W.CF_LIMIT, name);
        for (const c of cf) assert.equal(c.delta_minor, c.sts_minor - s.sts_minor);
        assert.match(W.sts_origin(model, mode, s.T).ref, /^c_[0-9a-f]{8}$/);
      }
      for (const it of E.list_waves_ex(model.ctx, mode).items) {
        assert.equal(W.wave_why(model, mode, it).ok, true, name + ' ' + mode + ': сумма волны');
        const cf = W.wave_counterfactuals(model, mode, it);
        assert.ok(cf.length <= W.CF_LIMIT, name);
        for (const c of cf) assert.equal(c.delta_minor, c.need_minor - it.metrics.need_minor);
      }
      assert.match(W.wave_origin(model, mode).ref, /^c_[0-9a-f]{8}$/);
      assert.match(W.verdict_origin(model, mode).ref, /^c_[0-9a-f]{8}$/);
    }
  }
});

test('TST-56 новые строки why_origin, sts_cf, wave_cf: есть в RU и EN, одинаковые плейсхолдеры, русские буквы в RU, ключ использован литералом в why_more.mjs', () => {
  const src = fs.readFileSync(path.join(DEMO, 'why_more.mjs'), 'utf8');
  const holders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const key of ['scenarios.why_origin', 'scenarios.sts_cf', 'scenarios.wave_cf']) {
    assert.equal(typeof SCEN.ru[key], 'string', key + ' RU');
    assert.equal(typeof SCEN.en[key], 'string', key + ' EN');
    assert.match(SCEN.ru[key], /[А-Яа-яЁё]/, key + ': в RU русские буквы');
    assert.doesNotMatch(SCEN.en[key], /[А-Яа-яЁё]/, key + ': в EN русских букв нет');
    assert.equal(holders(SCEN.ru[key]), holders(SCEN.en[key]), key + ': плейсхолдеры');
    assert.ok(src.includes("'" + key + "'"), key + ' использован литералом');
  }
  assert.ok(!/\.innerHTML|outerHTML|eval\(|new Function/.test(src), 'модуль без небезопасных вставок');
  assert.ok(!/style:|\.style\b/.test(src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')), 'нет inline-стилей');
});
