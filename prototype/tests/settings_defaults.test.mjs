// settings_defaults.test.mjs — FP-17, REQ-019 (+ REQ-016 для экрана): значения по умолчанию показываются на экране «Настройки» рядом с действующими.
// Покрывает: правка set_param с признаком reset (ключ снимается; у «не задан» — явный null; повтор — без изменений; отказы); модели settings_defaults
// (строки таблицы на G-001, план возврата, показ значений RU/EN); экран: «По умолчанию N» под полем, кнопка «Вернуть по умолчанию» (включена только при своём
// значении), возврат через общий путь (пересчёт, журнал, «Отменить», круг «журнал → рабочая область» с тем же inputs_hash), таблица всех параметров, EN,
// режим «только чтение» (поля и кнопки отключены, текст); статические проверки (нет innerHTML, inline-стилей, литералов умолчаний, импорта app.mjs).
// DOM в Node подменён заглушкой (как в settings.test.mjs): проверяется логика и связка с настоящим app.mjs/ext.mjs. Браузер не используется.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeNode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this._sel = null;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() {
    if (this.tagName === 'select') {
      if (this._sel !== null) return this._sel;
      const opts = this.children.filter((c) => c.tagName === 'option');
      const hit = opts.find((o) => o.attrs.selected !== undefined) ?? opts[0];
      return hit === undefined ? '' : hit.attrs.value;
    }
    return this._value;
  }
  set value(v) { if (this.tagName === 'select') this._sel = String(v); else this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createElementNS: (_ns, t) => new FakeNode(t),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: () => null,
  head: new FakeNode('head'),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);

const ENGINE = await imp('engine', 'index.mjs');
const { canon, analyze, gate } = ENGINE;
const PD = await imp('engine', 'param_defaults.mjs');
const APP = await imp('demo', 'app.mjs');
const { create_ext } = await imp('demo', 'ext.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const { apply_edit, PARAM_SPECS } = await imp('demo', 'ws_edit.mjs');
const { seeded_ports } = await imp('demo', 'ids.mjs');
const { events_to_ws } = await imp('demo', 'ws_bridge.mjs');
const { diff_unit, apply_unit } = await imp('demo', 'undo.mjs');
const ST = await imp('demo', 'settings.mjs');
const SD = await imp('demo', 'settings_defaults.mjs');

const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const G = load('g001.json');
const clone = (x) => JSON.parse(JSON.stringify(x));

// пакет подключается один раз «как в приложении»: строки settings.* и defaults.*, правки, экран
const PACK_EXT = create_ext({ ports: seeded_ports({ seed: 3 }) });
await PACK_EXT.load_packs({ pack_fp03: () => import(pathToFileURL(path.join(DEMO, 'pack_fp03.mjs')).href) });

/** Хост-заглушка с настоящим пересчётом страницы (`build_model`): отказ пересчёта откатывает правку, как в app.mjs. */
function make_env(ws = G, { lang = 'ru' } = {}) {
  const e = create_ext({ ports: seeded_ports({ seed: 5 }) });
  const st = { ws, lang, mode: 'worse', scenario: null, renders: 0, notes: [] };
  const build = (w) => APP.build_model(w, { lang: st.lang, scenario: st.scenario });
  st.model = build(ws);
  e.bind_host({
    get_ws: () => st.ws,
    get_model: () => st.model,
    lang: () => st.lang,
    mode: () => st.mode,
    fmt: () => APP.make_fmt(st.lang, st.model.cur, st.model.as_of_iso),
    set_ws: (next) => {
      let m;
      try { m = build(next); } catch (err) { return { ok: false, error: err }; }
      st.ws = next;
      st.model = m;
      return { ok: true };
    },
    adopt: (next, o) => { try { st.ws = next; st.model = build(next); e.reset(next, o); return { ok: true }; } catch (err) { return { ok: false, error: err }; } },
    render: () => { st.renders += 1; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  return { e, ctx: e.ctx, st };
}

const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (root, id) => find_all(root, (n) => n.attrs.id === id)[0];
const text_of = (n) => n.textContent;
const click = (node) => { assert.ok(node !== undefined, 'нет узла'); node.listeners.click[0](); };
const disabled = (node) => node.attrs.disabled !== undefined;
const NBSP = ' ';

// ── set_param с признаком reset ─────────────────────────────────────────────────────────────────────────────────────

test('REQ-019 FP-17 set_param + reset: собственное значение снимается — ключ пропадает из params, остальные параметры и данные не тронуты; повтор не меняет рабочую область', () => {
  const w0 = clone(G);
  assert.equal(w0.params.horizon_days, 57);
  const r = apply_edit(w0, { type: 'set_param', key: 'horizon_days', reset: true });
  assert.equal(r.ok, true);
  assert.equal(Object.hasOwn(r.ws.params, 'horizon_days'), false);
  assert.deepEqual({ ...r.ws.params, horizon_days: 57 }, w0.params, 'прочие параметры те же');
  assert.deepEqual(r.touched, ['params']);
  assert.equal(r.ws.accounts, w0.accounts, 'корзины не копируются и не меняются');
  assert.equal(canon(w0), canon(G), 'исходная рабочая область не мутирована');
  const again = apply_edit(r.ws, { type: 'set_param', key: 'horizon_days', reset: true });
  assert.equal(again.ok, true);
  assert.equal(again.ws, r.ws, 'ключа нет — рабочая область та же (по ссылке)');
  assert.deepEqual(again.touched, []);
  // действует умолчание словаря
  assert.equal(analyze(r.ws, { as_of: r.ws.as_of }).params.horizon_days, PD.vdefault('horizon_days'));
});

test('REQ-019 FP-17 set_param + reset: у параметров с «не задан» (buffer_minor, wave.threshold_minor) ключ остаётся с явным null — как и при чтении журнала', () => {
  for (const key of ['buffer_minor', 'wave.threshold_minor']) {
    const r = apply_edit(clone(G), { type: 'set_param', key, reset: true });
    assert.equal(r.ok, true, key);
    assert.equal(Object.hasOwn(r.ws.params, key), true, key + ': ключ есть');
    assert.equal(r.ws.params[key], null, key + ': не задан');
  }
  const none = { ...clone(G), params: {} };
  assert.equal(apply_edit(none, { type: 'set_param', key: 'buffer_minor', reset: true }).ws, none, 'ключа нет — без изменений');
  const no_params = { ...clone(G) };
  delete no_params.params;
  assert.equal(apply_edit(no_params, { type: 'set_param', key: 'horizon_days', reset: true }).ws, no_params, 'нет и params — без изменений');
});

test('REQ-019 FP-17 set_param + reset: отказы — reset не true, reset вместе со value, валюта решения, неизвестный ключ, лишнее поле; обычная запись значения работает как прежде', () => {
  const reason = (edit) => { const r = apply_edit(clone(G), edit); return r.ok ? null : [r.error.code, r.error.ctx.field, r.error.ctx.reason]; };
  assert.deepEqual(reason({ type: 'set_param', key: 'horizon_days', reset: false }), ['E_SCHEMA', 'reset', 'reset_must_be_true']);
  assert.deepEqual(reason({ type: 'set_param', key: 'horizon_days', reset: 1 }), ['E_SCHEMA', 'reset', 'reset_must_be_true']);
  assert.deepEqual(reason({ type: 'set_param', key: 'horizon_days', reset: true, value: 90 }), ['E_SCHEMA', 'value', 'reset_with_value']);
  assert.deepEqual(reason({ type: 'set_param', key: 'decision_currency', reset: true }), ['E_SCHEMA', 'key', 'not_resettable']);
  assert.deepEqual(reason({ type: 'set_param', key: 'kdf.iterations', reset: true }), ['E_SCHEMA', 'key', 'unknown_param']);
  assert.deepEqual(reason({ type: 'set_param', key: '__proto__', reset: true }), ['E_SCHEMA', 'key', 'unknown_param']);
  assert.equal(apply_edit(clone(G), { type: 'set_param', key: 'horizon_days', reset: true, extra: 1 }).ok, false, 'лишнее поле по-прежнему отвергается');
  assert.equal(apply_edit(clone(G), { type: 'set_param', key: 'horizon_days', value: 90 }).ws.params.horizon_days, 90, 'обычная запись значения');
  assert.equal(apply_edit(clone(G), { type: 'set_param', key: 'horizon_days' }).ok, false, 'без value и без reset — отказ, как раньше');
});

test('REQ-019 FP-17: возврат каждого редактируемого параметра на копии G-001 с чужими значениями даёт рабочую область, проходящую validate_ws, с умолчанием словаря в расчёте', () => {
  const w = clone(G);
  for (const key of SD.LISTED_KEYS) {
    const sp = PARAM_SPECS[key];
    const v = sp.kind === 'int' ? Math.min(sp.max, Math.max(sp.min, sp.min + 1)) : sp.kind === 'enum' ? sp.values.at(-1) : sp.kind === 'minor' ? 77700 : null;
    if (v !== null) w.params[key] = v;
  }
  let cur = w;
  for (const key of SD.LISTED_KEYS) {
    const r = apply_edit(cur, SD.reset_edit(key));
    assert.equal(r.ok, true, key + ': ' + JSON.stringify(r.error));
    cur = r.ws;
  }
  for (const key of SD.LISTED_KEYS) {
    const d = PD.describe_param(key, cur.params);
    assert.equal(d.is_default, true, key + ': действует умолчание');
    assert.equal(d.value, PD.vdefault(key), key);
  }
  assert.deepEqual(Object.keys(cur.params).filter((k) => cur.params[k] !== null), [], 'свои значения сняты, остались разве что явные null');
});

// ── модели settings_defaults ─────────────────────────────────────────────────────────────────────────────────────────

test('REQ-019 FP-17 модель: в таблицу входят 33 редактируемых параметра словаря (без валюты решения и kdf.*); на G-001 изменены горизонт, буфер и порог волн', () => {
  assert.equal(SD.LISTED_KEYS.length, 33);
  assert.ok(!SD.LISTED_KEYS.includes('decision_currency'));
  assert.ok(!SD.LISTED_KEYS.some((k) => k.startsWith('kdf.')));
  assert.deepEqual([...SD.LISTED_KEYS], PD.param_keys().filter((k) => k !== 'decision_currency' && !k.startsWith('kdf.')));
  const model = APP.build_model(G);
  const rows = SD.default_rows(model);
  assert.equal(rows.length, 33);
  assert.deepEqual(rows.filter((r) => r.changed).map((r) => r.key), ['horizon_days', 'buffer_minor', 'wave.threshold_minor']);
  const horizon = rows.find((r) => r.key === 'horizon_days');
  assert.deepEqual([horizon.default, horizon.value, horizon.explicit, horizon.is_default, horizon.kind], [180, 57, true, false, 'int']);
  const delay = rows.find((r) => r.key === 'worse.income_delay_days');
  assert.deepEqual([delay.explicit, delay.is_default, delay.changed, delay.hypothesis], [true, true, false, true], 'свой ключ с тем же числом — не «изменено»');
  const calib = rows.find((r) => r.key === 'calib.k');
  assert.deepEqual([calib.explicit, calib.value, calib.hypothesis], [false, 3, true], 'нет своего ключа — действует умолчание');
  assert.equal(rows.find((r) => r.key === 'debt.drift_tol_bp').phase, 'v2');
  assert.equal(SD.default_row(model, 'decision_currency'), null);
  assert.equal(SD.default_row(model, 'нет такого'), null);
  assert.equal(SD.default_row(null, 'horizon_days').value, 180, 'без модели — умолчание');
  assert.equal(SD.label_key('fx.stale_days'), 'defaults.p_fx_stale_days');
  for (const k of SD.LISTED_KEYS) for (const lang of ['ru', 'en']) assert.notEqual(I18N.t(lang, SD.label_key(k)), SD.label_key(k), `${lang}: подпись параметра ${k}`);
});

test('REQ-019 FP-17 модель: plan_reset — правка только если есть своё значение, отличное от умолчания; для равного умолчанию и для чужого ключа — пусто', () => {
  const model = APP.build_model(G);
  assert.deepEqual(SD.plan_reset(model, 'horizon_days'), { ok: true, edits: [{ type: 'set_param', key: 'horizon_days', reset: true }] });
  assert.deepEqual(SD.plan_reset(model, 'worse.income_delay_days'), { ok: true, edits: [] });
  assert.deepEqual(SD.plan_reset(model, 'calib.k'), { ok: true, edits: [] });
  assert.deepEqual(SD.plan_reset(model, 'decision_currency'), { ok: false, reason: 'unknown_param', edits: [] });
  assert.deepEqual(SD.plan_reset(model, 'kdf.wrap'), { ok: false, reason: 'unknown_param', edits: [] });
  assert.deepEqual(SD.reset_edit('rounding'), { type: 'set_param', key: 'rounding', reset: true });
});

test('REQ-019 FP-17 value_text: срок — со словом «дней», сумма — в валюте и формате пользователя, доля — в процентах, перечисление — подписью, null — «не задан»', async () => {
  const { ctx } = make_env(G);
  const { make_nf_fmt } = await imp('demo', 'number_format.mjs');
  const f = make_nf_fmt('ru', 'EUR', G.as_of);
  const vt = (key, v, fm = f) => SD.value_text(ctx, key, PARAM_SPECS[key].kind, v, fm);
  assert.equal(vt('horizon_days', 180), '180 дней');
  assert.equal(vt('worse.income_delay_days', 1), '1 день');
  assert.equal(vt('grace_days.income', 3), '3 дня', 'grace_days.* — тоже сроки');
  assert.equal(vt('buffer_minor', null), 'не задан');
  assert.equal(vt('wave.threshold_minor', null), 'не задан (считает движок)');
  assert.equal(vt('buffer_minor', 50000), f.money(50000));
  assert.equal(vt('rounding', 'half_even'), 'к ближайшему чётному');
  assert.equal(vt('rounding', 'ceil'), 'вверх');
  assert.equal(vt('headline_mode', 'worse'), 'если хуже');
  assert.equal(vt('headline_mode', 'plan'), 'по плану');
  assert.match(vt('match.tol_bp', 500), /^5\s%$/u);
  assert.match(vt('explain.share_cutoff_bp', 9000), /^90\s%$/u);
  assert.equal(vt('ready.q1', 3), '3');
  assert.equal(vt('mc.n_paths', 2000), '2000');
  // формат пользователя: «1.234,50» — точка тысяч, запятая десятичных
  const dot = make_nf_fmt('ru', 'EUR', G.as_of, { decimal: ',', thousands: '.' });
  assert.equal(vt('buffer_minor', 123450, dot), dot.money(123450));
  assert.match(vt('buffer_minor', 123450, dot), /^1\.234,50/u);
  const en = make_nf_fmt('en', 'EUR', G.as_of);
  assert.equal(vt('horizon_days', 1, en), '1 day');
});

// ── экран «Настройки» ────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-019 FP-17 экран: под полем горизонта «По умолчанию: 180 дней. Сейчас задано: 57 дней.», у сдвига «Сейчас действует оно.»; кнопка включена только при своём значении', () => {
  const { ctx } = make_env(G);
  const root = ST.render_settings(ctx);
  const line_h = text_of(by_id(root, 'set-horizon-default'));
  assert.match(line_h, /^По умолчанию: 180\sдней\. Сейчас задано: 57\sдней\.$/u);
  assert.match(text_of(by_id(root, 'set-delay-default')), /^По умолчанию: 14\sдней\. Сейчас действует оно\.$/u);
  assert.equal(disabled(by_id(root, 'set-horizon-reset')), false, 'горизонт изменён — вернуть можно');
  assert.equal(disabled(by_id(root, 'set-delay-reset')), true, 'сдвиг равен умолчанию — возвращать нечего');
  assert.equal(by_id(root, 'set-horizon-reset').attrs['aria-describedby'], 'set-horizon-default');
  assert.equal(text_of(by_id(root, 'set-horizon-reset')), 'Вернуть по умолчанию');
  // буфер и порог: умолчание — «не задан»
  assert.match(text_of(by_id(root, 'set-buffer-default')), /^По умолчанию: не задан\. Сейчас задано: 500,00\s€\.$/u);
  assert.match(text_of(by_id(root, 'set-threshold-default')), /^По умолчанию: не задан \(считает движок\)\. Сейчас задано: 30,00\s€\.$/u);
  // допуск по сумме — в процентах
  assert.match(text_of(by_id(root, 'set-tol-default')), /^По умолчанию: 5(?:[.,]0+)?\s%\. Сейчас действует оно\.$/u);
  // восемь полей форм — восемь строк умолчаний
  assert.equal(find_all(root, (n) => /^set-[a-z]+-default$/.test(n.attrs.id ?? '')).length, 8);
});

test('REQ-019 FP-17 «Вернуть по умолчанию» у горизонта: правка set_param+reset общим путём — ключ снят, действует 180, пересчёт, запись params.set в журнал, круг журнала даёт тот же inputs_hash', () => {
  const { ctx, st } = make_env(G);
  const n0 = ctx.journal.length;
  const root = ST.render_settings(ctx);
  assert.equal(st.model.ctx.params.horizon_days, 57);
  click(by_id(root, 'set-horizon-reset'));
  assert.equal(Object.hasOwn(st.ws.params, 'horizon_days'), false, 'собственное значение снято');
  assert.equal(st.model.ctx.params.horizon_days, 180, 'действует умолчание словаря');
  assert.equal(st.renders, 1, 'один пересчёт и одна перерисовка');
  assert.equal(ctx.journal.length, n0 + 1);
  assert.equal(ctx.journal.at(n0).type, 'params.set');
  assert.equal(ctx.journal.at(n0).payload.horizon_days, null, 'журнал не умеет удалять ключ: пишет null, который при чтении снова «ключа нет»');
  assert.ok(st.notes.some(([m, k]) => m === 'Сохранено.' && k === 'info'));
  // круг: журнал → рабочая область даёт тот же расчёт, что и сеанс (иначе после перезагрузки числа разошлись бы)
  const back = events_to_ws(ctx.journal.events());
  assert.equal(Object.hasOwn(back.params, 'horizon_days'), false);
  assert.equal(analyze(back, { as_of: back.as_of }).inputs_hash, analyze(st.ws, { as_of: st.ws.as_of }).inputs_hash);
  // экран перерисован: поле показывает 180, кнопка отключена, подтверждение — один раз
  const again = ST.render_settings(ctx);
  assert.equal(by_id(again, 'set-horizon').value, '180');
  assert.equal(disabled(by_id(again, 'set-horizon-reset')), true);
  assert.match(text_of(by_id(again, 'settings-horizon')), /Сохранено\./);
  assert.match(text_of(by_id(again, 'set-horizon-default')), /Сейчас действует оно\./);
  assert.equal(text_of(by_id(ST.render_settings(ctx), 'settings-horizon')).includes('Сохранено.'), false);
});

test('REQ-019 FP-17 возврат отменяется: diff_unit / apply_unit возвращают рабочую область побайтно (в обе стороны), в том числе для «не задан»', () => {
  for (const key of ['horizon_days', 'buffer_minor', 'rounding']) {
    const w0 = clone(G);
    if (key === 'rounding') w0.params.rounding = 'floor';
    const r = apply_edit(w0, SD.reset_edit(key));
    assert.equal(r.ok, true);
    const unit = diff_unit(w0, r.ws, { reason: 'set_param' });
    assert.ok(unit !== null, key);
    const undone = apply_unit(r.ws, unit, 'undo');
    assert.equal(undone.ok, true, key);
    assert.equal(canon(undone.ws), canon(w0), key + ': «Отменить» побайтно');
    const redone = apply_unit(undone.ws, unit, 'redo');
    assert.equal(canon(redone.ws), canon(r.ws), key + ': «Вернуть» побайтно');
  }
});

test('REQ-019 FP-17 буфер: «Вернуть по умолчанию» делает буфер «не задан» (явный null): предупреждение движка и гейт no_buffer; поле пустое; журнал даёт тот же расчёт', () => {
  const { ctx, st } = make_env(G);
  click(by_id(ST.render_settings(ctx), 'set-buffer-reset'));
  assert.equal(st.ws.params.buffer_minor, null);
  assert.ok(st.model.ctx.warnings.some((w) => w.code === 'W_BUFFER_UNSET'));
  assert.deepEqual(gate(st.model.ctx).reasons, ['no_buffer']);
  const again = ST.render_settings(ctx);
  assert.equal(by_id(again, 'set-buffer').value, '');
  assert.equal(disabled(by_id(again, 'set-buffer-reset')), true);
  const back = events_to_ws(ctx.journal.events());
  assert.equal(analyze(back, { as_of: back.as_of }).inputs_hash, analyze(st.ws, { as_of: st.ws.as_of }).inputs_hash);
});

test('REQ-019 FP-17 порог волн: возврат — «не задан»; правило округления: поле значения «0» (буфер ноль) не считается умолчанием и возвращается в «не задан»', () => {
  const { ctx, st } = make_env({ ...clone(G), params: { ...G.params, buffer_minor: 0 } });
  const root = ST.render_settings(ctx);
  assert.match(text_of(by_id(root, 'set-buffer-default')), /Сейчас задано: 0,00\s€\./u, '0 — «задан», это не умолчание');
  assert.equal(disabled(by_id(root, 'set-buffer-reset')), false);
  click(by_id(root, 'set-buffer-reset'));
  assert.equal(st.ws.params.buffer_minor, null);
  click(by_id(ST.render_settings(ctx), 'set-threshold-reset'));
  assert.equal(st.ws.params['wave.threshold_minor'], null);
});

test('REQ-019 FP-17 таблица «Все параметры и значения по умолчанию»: 33 строки, значения «действует / по умолчанию», пометка «гипотеза», кнопка «Вернуть» только у изменённых', () => {
  const { ctx, st } = make_env(G);
  const root = ST.render_settings(ctx);
  const card = by_id(root, 'settings-defaults');
  assert.ok(card !== undefined);
  assert.match(text_of(by_id(card, 'settings-defaults-title')), /^Все параметры и значения по умолчанию$/);
  const body = find_all(card, (n) => n.tagName === 'tbody')[0];
  const rows = body.children;
  assert.equal(rows.length, 33);
  const row = (key) => rows[SD.LISTED_KEYS.indexOf(key)];
  const cells = (r) => r.children.map((c) => c.textContent);
  assert.deepEqual(cells(row('horizon_days')).slice(0, 4), ['Горизонт прогноза', `57${NBSP}дней`.replace(NBSP, ' '), '180 дней', 'изменено в этом наборе']);
  const worse = cells(row('worse.income_delay_days'));
  assert.equal(worse[0], 'Сдвиг поступлений «если хуже» · гипотеза');
  assert.equal(worse[3], 'по умолчанию');
  assert.equal(worse[4], '—');
  // кнопки «Вернуть» — ровно у трёх изменённых (горизонт, буфер, порог волн); подпись для скринридера называет параметр
  const buttons = find_all(body, (n) => n.tagName === 'button');
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map((b) => b.attrs['aria-label']), ['Вернуть по умолчанию: Горизонт прогноза', 'Вернуть по умолчанию: Буфер', 'Вернуть по умолчанию: Порог значимого платежа']);
  assert.match(text_of(card), /Изменено параметров: 3 из 33\./);
  assert.equal(find_all(body, (n) => n.tagName === 'tr' && n.className === 'mark').length, 3, 'изменённые строки выделены');
  // возврат из таблицы — та же правка и тот же путь
  const n0 = ctx.journal.length;
  click(buttons[2]);
  assert.equal(st.ws.params['wave.threshold_minor'], null);
  assert.equal(ctx.journal.length, n0 + 1);
  const after = by_id(ST.render_settings(ctx), 'settings-defaults');
  assert.match(text_of(after), /Изменено параметров: 2 из 33\. Сохранено\./);
  assert.equal(find_all(after, (n) => n.tagName === 'tbody')[0].children.length, 33);
  // когда всё по умолчанию
  click(find_all(by_id(ST.render_settings(ctx), 'settings-defaults'), (n) => n.tagName === 'button')[0]);
  click(find_all(by_id(ST.render_settings(ctx), 'settings-defaults'), (n) => n.tagName === 'button')[0]);
  assert.match(text_of(by_id(ST.render_settings(ctx), 'settings-defaults')), /Все параметры имеют значения по умолчанию\./);
  assert.equal(find_all(by_id(ST.render_settings(ctx), 'settings-defaults'), (n) => n.tagName === 'button').length, 0);
});

test('REQ-019 FP-17 EN: «Default: 180 days. Currently set: 57 days.», «Reset to default», таблица и подписи по-английски', () => {
  const { ctx, st } = make_env(G, { lang: 'en' });
  const root = ST.render_settings(ctx);
  assert.match(text_of(by_id(root, 'set-horizon-default')), /^Default: 180 days\. Currently set: 57 days\.$/);
  assert.match(text_of(by_id(root, 'set-delay-default')), /^Default: 14 days\. It is in effect now\.$/);
  assert.equal(text_of(by_id(root, 'set-horizon-reset')), 'Reset to default');
  assert.match(text_of(by_id(root, 'set-buffer-default')), /^Default: not set\. Currently set: €500\.00\.$/);
  const card = by_id(root, 'settings-defaults');
  assert.equal(text_of(by_id(card, 'settings-defaults-title')), 'All parameters and their defaults');
  assert.match(text_of(card), /Parameters changed: 3 of 33\./);
  assert.match(text_of(card), /Forecast horizon/);
  assert.match(text_of(card), /hypothesis/);
  click(by_id(root, 'set-horizon-reset'));
  assert.equal(st.model.ctx.params.horizon_days, 180);
  assert.ok(st.notes.some(([m]) => m === 'Saved.'), JSON.stringify(st.notes));
});

test('REQ-016 FP-17 экран в режиме «только чтение»: сверху сказано почему, поля, кнопки сохранения и возврата отключены; запись, даже вызванная напрямую, отклоняется', () => {
  const { e, ctx, st } = make_env(G);
  e.reset(st.ws, { read_only: { newer_format: true, format: 'runway-journal/2', format_version: 2, known_version: 1, skipped: 0, source: 'readonly' } });
  const root = ST.render_settings(ctx);
  assert.match(text_of(root), /Файл открыт только для просмотра: настройки не меняются\./);
  for (const id of ['set-buffer', 'set-dcur', 'set-horizon', 'set-delay', 'set-gap', 'set-span', 'set-threshold', 'set-window', 'set-tol', 'set-today', 'set-nf-preset', 'set-nf-date']) assert.equal(disabled(by_id(root, id)), true, id + ' отключено'); // FP-29: +«Валюта решения»
  for (const id of ['set-buffer-reset', 'set-horizon-reset', 'set-delay-reset', 'set-threshold-reset']) assert.equal(disabled(by_id(root, id)), true, id + ' отключена');
  const submits = find_all(root, (n) => n.tagName === 'button' && n.attrs.type === 'submit');
  assert.equal(submits.length, 7); // FP-29: +форма «Валюта решения»
  assert.ok(submits.every(disabled), 'все кнопки «Сохранить» отключены');
  assert.ok(find_all(by_id(root, 'settings-defaults'), (n) => n.tagName === 'button').every(disabled), 'в таблице кнопки «Вернуть» отключены');
  assert.equal(disabled(find_all(root, (n) => n.tagName === 'button' && /Взять подсказку|Взять дату/.test(n.textContent))[0]), true);
  // прямой вызов обработчика: ничего не меняется
  const ws_before = st.ws;
  by_id(root, 'set-horizon-reset').listeners.click[0]();
  find_all(by_id(root, 'settings-defaults'), (n) => n.tagName === 'button')[0].listeners.click[0]();
  assert.equal(st.ws, ws_before, 'данные не менялись');
  const r = ST.save_edits(ctx, [{ type: 'set_param', key: 'horizon_days', value: 10 }]);
  assert.equal(r.ok, false);
  assert.equal(r.error.ctx.reason, 'read_only');
  assert.equal(st.ws, ws_before);
  // вне режима тот же экран полностью рабочий (проверено выше), а после выхода из режима поля снова доступны
  e.reset(clone(G), {});
  const free = ST.render_settings(ctx);
  assert.equal(disabled(by_id(free, 'set-horizon')), false);
  assert.ok(!text_of(free).includes('настройки не меняются'));
});

// ── статические проверки ─────────────────────────────────────────────────────────────────────────────────────────────

test('TST-59 TST-56 FP-17: новый модуль — без innerHTML, inline-стилей, eval, внешних адресов и импорта app.mjs; литералов умолчаний нет; запись — только через переданный обработчик', () => {
  const src = fs.readFileSync(path.join(DEMO, 'settings_defaults.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1 ');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function|\bstyle\s*[:=]|setAttribute\(\s*['"]style/.test(code), 'нет впрысков и inline-стилей');
  assert.ok(!/https?:\/\//.test(code), 'нет внешних адресов');
  assert.ok(!/from '\.\/app\.mjs'/.test(code), 'пакет не импортирует app.mjs');
  assert.ok(!/ctx\.set_ws\(|ctx\.edit\(/.test(code), 'сам модуль ничего не пишет: запись — обработчик on_reset, который передаёт settings.mjs');
  for (const [key, value] of [['horizon_days', 180], ['worse.income_delay_days', 14], ['match.tol_bp', 500], ['fx.stale_days', 30]]) {
    assert.ok(!new RegExp(`${key.replace(/\./g, '\\.')}['"]?\\s*:\\s*${value}\\b`).test(code), `нет литерала ${key}: ${value}`);
  }
  // settings.mjs по-прежнему пишет только через apply_edit → один ctx.set_ws; возврат идёт тем же путём commit → save_edits
  const settings = fs.readFileSync(path.join(DEMO, 'settings.mjs'), 'utf8');
  assert.equal((settings.match(/\bctx\.set_ws\(/g) ?? []).length, 1);
  assert.match(settings, /reset_edit\(key\)/);
  assert.match(settings, /commit\(ctx, status, \[reset_edit\(key\)\]/);
  const css = fs.readFileSync(path.join(DEMO, 'css', 'settings.css'), 'utf8');
  assert.ok(!/https?:\/\/|@import|url\(/.test(css), 'в стилях нет внешних адресов');
  assert.match(css, /fp17-defaults/);
});

test('TST-56 FP-17: каталог defaults.* — RU и EN, паритет ключей и плейсхолдеров, каждый ключ используется в коде (литерал или динамический префикс), русские буквы в RU-строках', async () => {
  const cat = (await imp('demo', 'i18n', 'defaults.mjs')).default;
  assert.deepEqual(Object.keys(cat.ru).sort(), Object.keys(cat.en).sort());
  const src = ['settings_defaults.mjs', 'settings.mjs'].map((f) => fs.readFileSync(path.join(DEMO, f), 'utf8')).join('\n');
  const prefixes = [...src.matchAll(/'(defaults\.[a-z0-9_]*)'\s*\+/g)].map((m) => m[1]);
  const literals = new Set([...src.matchAll(/'(defaults\.[a-z0-9_]+)'(?!\s*\+)/g)].map((m) => m[1]));
  for (const k of Object.keys(cat.ru)) {
    assert.ok(literals.has(k) || prefixes.some((p) => k.startsWith(p)), 'ключ без использования: ' + k);
    assert.match(cat.ru[k], /[а-яё]/i, k);
    assert.deepEqual([...cat.ru[k].matchAll(/{(\w+)}/g)].map((m) => m[1]).sort(), [...cat.en[k].matchAll(/{(\w+)}/g)].map((m) => m[1]).sort(), 'плейсхолдеры ' + k);
  }
  for (const k of literals) assert.ok(Object.hasOwn(cat.ru, k), 'код ссылается на несуществующий ключ ' + k);
  // запрещённые формулировки (vocab.json → forbidden_phrases) в строках нет
  const vocab = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  const corpus = [...Object.values(cat.ru), ...Object.values(cat.en)].join('\n').toLowerCase().replace(/ё/g, 'е');
  for (const phrase of vocab.forbidden_phrases) assert.ok(!corpus.includes(phrase.toLowerCase().replace(/ё/g, 'е')), 'запрещённая формулировка: ' + phrase);
});
