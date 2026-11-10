// undo_all.test.mjs — единая стопка «Отменить / Вернуть» (этап S1.3, FP-04 + хвост приёмки волны 1; REQ-090, TST-16).
// Что проверяется: «Отменить» откатывает ЛЮБОЕ действие, записанное общим путём `ctx.set_ws` / `ctx.edit` (формы данных, настройки, «Сегодня», формат чисел,
// сценарии, правки волн, контрагенты, факты), а не только факты/якоря/аллокации/резервы; рабочая область возвращается побайтно (canon) и с тем же
// `inputs_hash`; один пользовательский шаг — одна единица; конфликт при постороннем изменении; исключённые причины (отмена/возврат, замена набора
// целиком, мастер импорта) в стопку не пишутся; двойной записи нет (FP-04 помечает свои записи `undo: 'recorded'`); предел 50; кнопки навигации в настоящем
// app.mjs на заглушке DOM (по образцу entry_boot.test.mjs): доступность и подпись aria-label на RU и EN.
// Два слоя: (А) реестр с подставной страницей и стопкой пакета FP-04 (пакет регистрируется напрямую, чтобы видеть его стопку), (Б) настоящий app.mjs.
// Браузер и сеть не используются; тесты не запускают серверов и фоновых процессов.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');

// ── заглушка DOM (как в entry_boot.test.mjs) ─────────────────────────────────────────────────────────────────────────

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false;
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
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const dom_listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body: new Node_('body'),
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (dom_listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });

import { analyze, canon } from '../engine/index.mjs';
import { create_ext, ext } from '../demo/ext.mjs';
import { seeded_ports } from '../demo/ids.mjs';
import { t as tr_of } from '../demo/i18n.mjs';
import { apply_edit, list_edit_types } from '../demo/ws_edit.mjs';
import { BUCKETS } from '../demo/ws_bridge.mjs';
import {
  UNDO_BUCKETS, UNDO_ARRAY_BUCKETS, UNDO_SLOT_BUCKETS, UNDO_LIMIT, UNDO_RECORDED, UNDO_CLEAR_REASONS, UNDO_SKIP_REASONS, UNDO_EXCLUDED_REASONS, UNDO_LABEL_KEYS, REASON_KINDS,
  create_undo_stack, diff_unit, apply_unit, unit_label, describe_unit, auto_record,
} from '../demo/undo.mjs';
import { register as register_fp04 } from '../demo/pack_fp04.mjs';
import { prepare_entry, commit_entry, resolve_pending } from '../demo/entry.mjs';
import { anchor_confirm } from '../demo/anchor_dialog.mjs';
import { save_edits } from '../demo/settings.mjs';
import { commit_edits } from '../demo/forms.mjs';

const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const N = (x) => String(x).replace(/[  ]/g, ' ');
const hash_of = (ws) => analyze(ws, { as_of: ws.as_of }).inputs_hash;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };

// настоящий app.mjs подключается ДО регистрации тестов: пока идёт загрузка пакетов, node:test уже запускал бы первые тесты
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // document.getElementById('app-title') !== null → boot() запускается сам
// boot асинхронный: пакеты, набор данных, boot-хук; ждём набор данных (до 10 с) и ещё немного — на хук `boot`
for (let i = 0; i < 100 && ext.ctx.get_ws() === null; i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 500));

// ── слой А: реестр с подставной страницей и стопкой пакета FP-04 ───────────────────────────────────────────────────────

const st = { ws: G, notes: [], renders: 0, lang: 'ru', refuse: false, probe: null };
const e = create_ext({ ports: seeded_ports({ seed: 16 }) });
e.bind_host({
  get_ws: () => st.ws,
  get_model: () => ({ ctx: analyze(st.ws, { as_of: st.ws.as_of }) }),
  lang: () => st.lang,
  mode: () => 'worse',
  fmt: () => null,
  set_ws: (next) => {
    if (st.refuse) return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'forced_refusal' } } };
    try { analyze(next, { as_of: next.as_of }); } catch (x) { return { ok: false, error: x }; }
    st.ws = next;
    return { ok: true };
  },
  render: () => { st.renders += 1; st.probe?.(); },
  notify: (m, k) => { st.notes.push([m, k]); },
});
// пакет подключается напрямую (каталоги строк и стили уже принял настоящий app.mjs): так видна его собственная стопка `deps.undo`
const deps = register_fp04({ ctx: e.ctx, register_i18n: () => {}, ensure_css: () => {}, register_hook: e.register_hook, register_slot_item: e.register_slot_item });
const ctx = e.ctx;
const infos = [];
ctx.subscribe((i) => infos.push(i));

/** Новая рабочая область на странице: журнал и стопка пересоздаются (как при смене набора данных). */
function reset(ws = clone(G), lang = 'ru') {
  st.ws = ws; st.lang = lang; st.notes = []; st.renders = 0; st.refuse = false; st.probe = null;
  e.reset(ws);
  infos.length = 0; // событие `adopt` самой замены не считается
  return deps;
}
const ed = (edit, o) => { const r = ctx.edit(edit, o); assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };
/** Посторонняя запись: причина `import` (мастер импорта в стопку не пишет) — так моделируется «данные изменились помимо стопки». */
const foreign = (edit) => { const r = apply_edit(st.ws, edit, { new_id: ctx.new_id }); assert.equal(r.ok, true, JSON.stringify(r.error)); assert.equal(ctx.set_ws(r.ws, { reason: 'import' }).ok, true); return r.ws; };

// ── 1. состав корзин, исключения, подписи ───────────────────────────────────────────────────────────────────────────

test('TST-16 REQ-090: корзины отмены = корзины моста ws↔журнал (плюс слоты params и meta); прежние четыре корзины и предел 50 не изменились; исключённые причины заданы константой', () => {
  assert.deepEqual(UNDO_BUCKETS.map((b) => [...b]), [['facts', 'event_id'], ['anchors', 'anchor_id'], ['allocations', 'allocation_id'], ['reserves', 'reserve_id']]);
  assert.deepEqual(UNDO_ARRAY_BUCKETS.map((b) => b[0]).sort(), BUCKETS.map((b) => b.ws_key).sort(), 'ни одна корзина рабочей области не осталась без отмены');
  assert.deepEqual([...UNDO_SLOT_BUCKETS], ['params', 'meta']);
  assert.equal(UNDO_LIMIT, 50);
  assert.equal(UNDO_RECORDED, 'recorded');
  for (const r of ['undo', 'redo', 'adopt', 'restore', 'import', 'import_rollback']) assert.ok(UNDO_EXCLUDED_REASONS.includes(r), r);
  assert.deepEqual([...UNDO_CLEAR_REASONS], ['adopt', 'restore'], 'замена набора целиком очищает стопку');
  assert.ok(!UNDO_SKIP_REASONS.includes('adopt') && !UNDO_SKIP_REASONS.includes('restore'));
});

test('TST-16 REQ-090: все причины записи мастера импорта (FP-06) внесены в список исключений; «restore» и «adopt» очищают стопку (сверка по исходному коду)', () => {
  const read = (f) => fs.readFileSync(path.join(DEMO, f), 'utf8');
  const reasons = new Set();
  for (const f of ['import_wizard.mjs', 'import_model.mjs', 'pack_fp06.mjs']) {
    for (const m of read(f).matchAll(/set_ws\([^;\n]*?\{\s*reason:\s*'([a-z_]+)'/g)) reasons.add(m[1]);
  }
  assert.ok(reasons.size >= 2, 'мастер импорта пишет как минимум «import» и «import_rollback»: ' + [...reasons].join(','));
  for (const r of reasons) assert.ok(UNDO_EXCLUDED_REASONS.includes(r), 'причина мастера импорта не исключена: ' + r);
  // замена набора целиком — только причина restore (data_runtime.mjs)
  const restores = [...read('data_runtime.mjs').matchAll(/set_ws\([^;\n]*?\{\s*reason:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(restores.length >= 3 && restores.every((r) => UNDO_CLEAR_REASONS.includes(r)), restores.join(','));
});

test('TST-16 REQ-090: подпись действия — для каждого вида есть строка RU и EN, плейсхолдер подставлен; неизвестный вид — общая подпись; каждый вид правки известен подписи', () => {
  const money = (minor, cur) => `${minor / 100} ${cur}`;
  for (const lang of ['ru', 'en']) {
    const tr = (k, p) => tr_of(lang, k, p);
    for (const [kind, key] of Object.entries(UNDO_LABEL_KEYS)) {
      assert.notEqual(tr(key), key, `${lang}: нет строки ${key}`);
      const label = unit_label({ kind, amount_minor: -1250, currency: 'EUR' }, tr, money);
      assert.ok(label !== '' && !label.includes('{') && label === label.trim(), `${lang}/${kind}: «${label}»`);
    }
    assert.equal(unit_label({ kind: 'нет_такого' }, tr, money), tr('entry.u_other'));
    assert.equal(unit_label({ kind: '__proto__' }, tr, money), tr('entry.u_other'), 'неизвестный вид не берётся из прототипа');
    assert.equal(unit_label(null, tr, money), tr('entry.u_other'));
    assert.equal(unit_label({ kind: 'expense', amount_minor: -1250, currency: 'EUR' }, tr, money), lang === 'ru' ? 'расход 12.5 EUR' : 'expense 12.5 EUR', 'прежние подписи с суммой не менялись');
    assert.equal(unit_label({ kind: 'anchor' }, tr, money), lang === 'ru' ? 'сверка остатка' : 'balance reconciliation', 'без суммы подпись не заканчивается пробелом');
  }
  for (const type of list_edit_types()) assert.ok(Object.hasOwn(REASON_KINDS, type), `вид правки ${type} не отнесён к виду подписи`);
  for (const kind of Object.values(REASON_KINDS)) assert.ok(kind === 'fact' || Object.hasOwn(UNDO_LABEL_KEYS, kind), kind);
});

// ── 2. разность и применение: слоты, составные ключи, порядок ──────────────────────────────────────────────────────────

test('TST-16 REQ-090: параметры — слот по ключу: изменение, значение null (не то же, что нет ключа), появление и исчезновение ключа; пустой params не остаётся лишним', () => {
  const w0 = clone(G);
  const chg = (mut) => { const w = clone(w0); mut(w); return w; };
  const round = (w1, label) => {
    const u = diff_unit(w0, w1, { kind: 'settings' });
    assert.ok(u !== null, label);
    const undone = apply_unit(w1, u, 'undo');
    assert.equal(undone.ok, true, label);
    assert.equal(canon(undone.ws), canon(w0), label + ': отмена побайтно');
    const redone = apply_unit(undone.ws, u, 'redo');
    assert.equal(redone.ok, true, label);
    assert.equal(canon(redone.ws), canon(w1), label + ': возврат побайтно');
    return u;
  };
  const a = round(chg((w) => { w.params.buffer_minor = 60000; }), 'значение изменено');
  assert.deepEqual(a.changes.map((c) => [c.bucket, c.key, c.before, c.after]), [['params', 'buffer_minor', { value: 50000 }, { value: 60000 }]]);
  const b = round(chg((w) => { w.params.buffer_minor = null; }), 'значение null');
  assert.deepEqual(b.changes[0].after, { value: null }, 'null — это значение, а не отсутствие ключа');
  const c = round(chg((w) => { w.params['fx.stale_days'] = 5; }), 'ключ появился');
  assert.equal(c.changes[0].before, null);
  const d = round(chg((w) => { delete w.params.buffer_minor; }), 'ключ исчез');
  assert.equal(d.changes[0].after, null);
  const both = round(chg((w) => { w.params.buffer_minor = 1; w.params.horizon_days = 30; w.params['fx.stale_days'] = 2; delete w.params['wave.gap_days']; }), 'несколько ключей — одна единица');
  assert.equal(both.changes.length, 4);
  // null и «нет ключа» различаются: единица, снятая с null, не применяется к области без ключа
  const nul = diff_unit(w0, chg((w) => { w.params.buffer_minor = null; }));
  const absent = chg((w) => { delete w.params.buffer_minor; });
  assert.equal(apply_unit(absent, nul, 'undo').ok, false);
  // params не было вовсе: после отмены нет и пустого объекта
  const no_params = chg((w) => { delete w.params; });
  const with_one = { ...no_params, params: { horizon_days: 40 } };
  const u = diff_unit(no_params, with_one, {});
  assert.deepEqual(u.presence, { params: { before: false, after: true } });
  assert.equal(canon(apply_unit(with_one, u, 'undo').ws), canon(no_params));
  assert.equal(Object.hasOwn(apply_unit(with_one, u, 'undo').ws, 'params'), false);
  assert.equal(canon(apply_unit(no_params, u, 'redo').ws), canon(with_one));
  // ключи-ловушки прототипа не отслеживаются и не применяются
  const evil = JSON.parse('{"params":{"__proto__":{"x":1},"horizon_days":5}}');
  assert.deepEqual(diff_unit({ ...w0, params: {} }, { ...w0, ...evil }).changes.map((x) => x.key), ['horizon_days']);
  assert.equal(apply_unit(w0, { changes: [{ bucket: 'params', key: '__proto__', before: null, after: { value: 1 } }] }, 'redo').ok, false);
});

test('TST-16 REQ-090: метаполя верхнего уровня (as_of, number_format, name, locale, decision_currency) — слот meta: добавление, смена и удаление поля; чужое поле-корзина не принимается за метаполе', () => {
  const w0 = clone(G);
  const cases = [
    ['as_of', (w) => { w.as_of = '2026-10-05'; }],
    ['number_format добавлен', (w) => { w.number_format = { decimal: '.', thousands: ',' }; }],
    ['name', (w) => { w.name = 'Другое имя'; }],
    ['locale', (w) => { w.locale = 'en'; }],
    ['decision_currency', (w) => { w.decision_currency = 'USD'; }],
    ['поле удалено', (w) => { delete w.locale; }],
    ['прочее поле', (w) => { w.note_text = 'заметка'; }],
  ];
  for (const [label, mut] of cases) {
    const w1 = clone(w0); mut(w1);
    const u = diff_unit(w0, w1, {});
    assert.ok(u.changes.every((c) => c.bucket === 'meta'), label);
    assert.equal(canon(apply_unit(w1, u, 'undo').ws), canon(w0), label);
    assert.equal(canon(apply_unit(apply_unit(w1, u, 'undo').ws, u, 'redo').ws), canon(w1), label);
  }
  // number_format убран (null) и возвращён
  const w_nf = { ...w0, number_format: { decimal: ',', thousands: ' ' } };
  const w_no = clone(w0);
  const u = diff_unit(w_nf, w_no, {});
  assert.deepEqual(u.changes.map((c) => [c.bucket, c.key, c.after]), [['meta', 'number_format', null]]);
  assert.equal(canon(apply_unit(w_no, u, 'undo').ws), canon(w_nf));
  // единица не может записать корзину как метаполе
  assert.equal(apply_unit(w0, { changes: [{ bucket: 'meta', key: 'facts', before: null, after: { value: [] } }] }, 'redo').ok, false);
  assert.equal(apply_unit(w0, { changes: [{ bucket: 'meta', key: 'params', before: null, after: { value: {} } }] }, 'redo').ok, false);
});

test('TST-16 REQ-090: составные ключи — overrides (rule_id@nominal_date) и tax_rules (tax_rule_id@version): добавление и удаление, версии налогового правила не смешиваются', () => {
  const w0 = clone(G);
  const skip = apply_edit(w0, { type: 'set_occurrence_override', override: { rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'skip' } }, {});
  assert.equal(skip.ok, true, JSON.stringify(skip.error));
  const u = diff_unit(w0, skip.ws, {});
  assert.deepEqual(u.changes.map((c) => [c.bucket, c.key]), [['overrides', 'R-RENT@2026-11-25']]);
  assert.equal(canon(apply_unit(skip.ws, u, 'undo').ws), canon(w0));
  const tr2 = apply_edit(w0, { type: 'upsert_tax_rule', tax_rule: { tax_rule_id: 'TR-20', name: 'Правило 20 %, версия 2', rate_bp: 1800, applies_to: { stream_ids: ['S-HOURLY'], tags: [] }, valid_from: '2026-11-01', reserve_id: 'RES-TAX' } }, {});
  assert.equal(tr2.ok, true, JSON.stringify(tr2.error));
  const t = diff_unit(w0, tr2.ws, {});
  assert.deepEqual(t.changes.map((c) => [c.bucket, c.key, c.before === null]), [['tax_rules', 'TR-20@2', true]], 'новая версия — отдельная запись, версия 1 не тронута');
  assert.equal(canon(apply_unit(tr2.ws, t, 'undo').ws), canon(w0));
  // версия 1 изменена посторонним — отмена версии 2 всё равно возможна (другой ключ), а отмена правки версии 1 — нет
  const v1_tampered = clone(tr2.ws); v1_tampered.tax_rules[0].name = 'другое';
  assert.equal(apply_unit(v1_tampered, t, 'undo').ok, true);
});

test('TST-16 REQ-090: порядок элементов — удаление из середины и правка волн, уходящая в конец списка, возвращаются на прежнее место (порядок применения волн сохраняется)', () => {
  const w0 = clone(G);
  // удаление факта из середины: «просто вернуть в конец» дало бы другой порядок
  const mid = w0.facts[10].event_id;
  const gone = apply_edit(w0, { type: 'void_fact', event_id: mid }, {}).ws;
  const u = diff_unit(w0, gone, {});
  assert.deepEqual(Object.keys(u.order), ['facts']);
  assert.equal(canon(apply_unit(gone, u, 'undo').ws), canon(w0), 'факт на своём месте, а не в конце');
  assert.equal(canon(apply_unit(apply_unit(gone, u, 'undo').ws, u, 'redo').ws), canon(gone));
  // чужие элементы (появились помимо единицы) остаются на своих местах, единица всё равно применяется
  const extra = { ...gone, facts: [...gone.facts, { ...w0.facts[0], event_id: 'tx-extra', date: '2026-10-01' }] };
  const back = apply_unit(extra, u, 'undo');
  assert.equal(back.ok, true);
  assert.deepEqual(back.ws.facts.map((f) => f.event_id), [...w0.facts.map((f) => f.event_id), 'tx-extra']);
  // правки волн: порядок записей = порядок применения; правка с тем же id уходит в конец
  const ov = (id, a, b) => ({ type: 'set_wave_override', override: { override_id: id, action: 'pin', event_ids: ['tx-g001-01'], pin_range: { from: a, to: b } } });
  let w = w0;
  for (const [id, a, b] of [['wov_a', '2026-10-01', '2026-10-03'], ['wov_b', '2026-10-02', '2026-10-04'], ['wov_c', '2026-10-03', '2026-10-05']]) {
    const r = apply_edit(w, ov(id, a, b), {});
    assert.equal(r.ok, true, JSON.stringify(r.error));
    w = r.ws;
  }
  const moved = apply_edit(w, ov('wov_a', '2026-10-01', '2026-10-09'), {}).ws;
  assert.deepEqual(moved.wave_overrides.map((o) => o.override_id), ['wov_b', 'wov_c', 'wov_a']);
  const mu = diff_unit(w, moved, {});
  assert.equal(mu.order.wave_overrides.before.join(), 'wov_a,wov_b,wov_c');
  assert.equal(mu.order.wave_overrides.after.join(), 'wov_b,wov_c,wov_a');
  assert.equal(canon(apply_unit(moved, mu, 'undo').ws), canon(w), 'отмена возвращает a на первое место');
  assert.equal(canon(apply_unit(apply_unit(moved, mu, 'undo').ws, mu, 'redo').ws), canon(moved), 'возврат — снова в конец');
  const removed = apply_edit(w, { type: 'set_wave_override', override_id: 'wov_b', remove: true }, {}).ws;
  const ru = diff_unit(w, removed, {});
  assert.equal(canon(apply_unit(removed, ru, 'undo').ws), canon(w), 'снятая правка вернулась на второе место');
  // служебное поле seq (ставит свёртка журнала) разницей не считается
  const with_seq = { ...w, wave_overrides: w.wave_overrides.map((o, i) => ({ ...o, seq: 10 + i })) };
  const re_seq = { ...w, wave_overrides: w.wave_overrides.map((o, i) => ({ ...o, seq: 100 + i })) };
  assert.equal(diff_unit(with_seq, re_seq, {}), null, 'другой seq при тех же правках — не действие пользователя');
  const mod = { ...with_seq, wave_overrides: with_seq.wave_overrides.map((o) => (o.override_id === 'wov_a' ? { ...o, pin_range: { from: '2026-10-01', to: '2026-10-08' } } : o)) };
  const unit_seq = diff_unit(with_seq, mod, {});
  assert.equal(unit_seq.changes.length, 1);
  const mod_reseq = { ...mod, wave_overrides: mod.wave_overrides.map((o, i) => ({ ...o, seq: 100 + i })) };
  assert.equal(apply_unit(mod_reseq, unit_seq, 'undo').ok, true, 'пересчитанный seq не даёт ложного конфликта');
});

test('TST-16 REQ-090: корзина, которой не было, после отмены не остаётся пустым массивом; чужие элементы без идентификатора не отслеживаются', () => {
  const w0 = clone(G); delete w0.counterparties; delete w0.debts;
  const w1 = apply_edit(w0, { type: 'add_counterparty', counterparty: { counterparty_id: 'cp_x', name: 'ИП Тест' } }, {}).ws;
  const u = diff_unit(w0, w1, {});
  assert.deepEqual(u.presence, { counterparties: { before: false, after: true } });
  const back = apply_unit(w1, u, 'undo').ws;
  assert.equal(Object.hasOwn(back, 'counterparties'), false);
  assert.equal(canon(back), canon(w0));
  assert.equal(canon(apply_unit(back, u, 'redo').ws), canon(w1));
  const odd = { ...w0, rules: [...w0.rules, 'не объект', { name: 'без идентификатора' }] };
  assert.equal(diff_unit(w0, odd, {}), null, 'элементы без идентификатора не отслеживаются (как раньше)');
});

// ── 3. каждый вид правки: отмена и возврат побайтно, один шаг — одна единица ───────────────────────────────────────

const RULE_NEW = { rule_id: 'R-GYM', version: 1, account_id: 'acc_main', name: 'Зал', kind: 'expense', amount: { exp_minor: -3000 }, currency: 'EUR', freq: 'M', interval: 1, month_end: 'clamp', weekend: 'next', calendar_id: 'cal-main', exdates: [], is_obligation: true, is_estimate: false, tag: 'зал', by_monthday: [15], start_date: '2026-10-15' };
// Третье поле — «state_hash журнала после отмены равен хэшу до действия». Не равен (`false`) по свойствам самого журнала, а не стопки: параметра не было
// вовсе (мост пишет в журнал `null`, а не «убрать ключ») и факт, возвращённый отменой удаления (в состоянии журнала у факта идентификатор записи — новый).
// Рабочая область и inputs_hash возвращаются точно во всех случаях.
const EDIT_CASES = [
  ['set_param: буфер', () => ({ type: 'set_param', key: 'buffer_minor', value: 60000 }), true],
  ['set_param: буфер «не задан» (null)', () => ({ type: 'set_param', key: 'buffer_minor', value: null }), true],
  ['set_param: горизонт', () => ({ type: 'set_param', key: 'horizon_days', value: 30 }), true],
  ['set_param: параметра не было (ключ появляется)', () => ({ type: 'set_param', key: 'fx.stale_days', value: 5 }), false],
  ['set_as_of («Сегодня»)', () => ({ type: 'set_as_of', date: '2026-10-05' }), true],
  ['set_number_format', () => ({ type: 'set_number_format', number_format: { decimal: '.', thousands: ',' } }), true],
  ['upsert_rule: новое', () => ({ type: 'upsert_rule', rule: RULE_NEW }), true],
  ['upsert_rule: правка суммы (версия растёт)', () => ({ type: 'upsert_rule', rule: { ...G.rules[1], amount: { exp_minor: -13000 } } }), true],
  ['delete_rule', () => ({ type: 'delete_rule', rule_id: 'R-UTIL' }), true],
  ['upsert_stream', () => ({ type: 'upsert_stream', stream: { ...G.streams[0], rate_minor: 3200 } }), true],
  ['upsert_tax_rule: новая версия', () => ({ type: 'upsert_tax_rule', tax_rule: { tax_rule_id: 'TR-20', name: 'Правило, версия 2', rate_bp: 1800, applies_to: { stream_ids: ['S-HOURLY'], tags: [] }, valid_from: '2026-11-01', reserve_id: 'RES-TAX' } }), true],
  ['upsert_reserve: новое накопление', () => ({ type: 'upsert_reserve', reserve: { reserve_id: 'RES-GIFT', kind: 'sinking', name: 'Подарок', currency: 'EUR', funded_start_minor: 0, funded_as_of: '2026-10-04', mode: 'fixed', fixed_minor: 5000 } }), true],
  ['upsert_account', () => ({ type: 'upsert_account', account: { account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR' } }), true],
  ['upsert_fx_rate', () => ({ type: 'upsert_fx_rate', rate: { fx_id: 'fx-usd-1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 92, den: 100 } }), true],
  ['save_scenario: новый', () => ({ type: 'save_scenario', scenario: { scenario_id: 'scn-new', name: 'Тест', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 7 }] } }), true],
  ['delete_scenario (первый из двух)', () => ({ type: 'delete_scenario', scenario_id: 'scn-delay-14' }), true],
  ['set_wave_override: новая правка', () => ({ type: 'set_wave_override', override: { override_id: 'wov_1', action: 'pin', event_ids: ['tx-g001-01'], pin_range: { from: '2026-10-01', to: '2026-10-03' } } }), true],
  ['add_counterparty', () => ({ type: 'add_counterparty', counterparty: { counterparty_id: 'cp_1', name: 'ИП Тест', usual_delay_days: 3 } }), true],
  ['add_fact', () => ({ type: 'add_fact', fact: { event_id: 'tx-new-1', account_id: 'acc_main', date: '2026-10-04', amount_minor: -1550, tag: 'кофе' } }), true],
  ['void_fact: из середины списка', () => ({ type: 'void_fact', event_id: G.facts[10].event_id }), false],
  ['add_purchase', () => ({ type: 'add_purchase', purchase: { purchase_id: 'pur-new', name: 'Тест', currency: 'EUR', parts: [{ date: '2026-10-20', amount_minor: 4500 }] } }), true],
  ['set_anchor', () => ({ type: 'set_anchor', anchor: { anchor_id: 'anc-g001-1004', account_id: 'acc_main', date: '2026-10-04', amount_minor: 395000 } }), true],
];

for (const [label, make, journal_exact] of EDIT_CASES) {
  test(`TST-16 REQ-090 ${label}: «Отменить» и «Вернуть» восстанавливают рабочую область побайтно (canon) и inputs_hash; одна правка — одна единица`, () => {
    reset();
    const ws0 = st.ws;
    const j = ctx.journal;
    const n0 = j.length;
    const prefix0 = j.prefix_hash(n0);
    const hash0 = j.state_hash();
    const ih0 = hash_of(ws0);
    ed(make());
    const ws1 = st.ws;
    const ih1 = hash_of(ws1);
    assert.notEqual(canon(ws1), canon(ws0), 'правка изменила рабочую область');
    assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 }, 'один шаг — одна единица');
    assert.equal(deps.undo.can_undo(), true);
    const u = deps.undo.undo(ctx);
    assert.equal(u.ok, true, JSON.stringify(u.error));
    assert.equal(canon(st.ws), canon(ws0), 'после «Отменить» — побайтно как до действия');
    assert.equal(hash_of(st.ws), ih0, 'inputs_hash как до действия');
    if (journal_exact) assert.equal(j.state_hash(), hash0, 'state_hash журнала как до действия');
    assert.equal(j.prefix_hash(n0), prefix0, 'журнал только дописывается');
    assert.ok(j.length > n0, 'отмена — новые записи, а не удаление старых');
    assert.deepEqual(deps.undo.size(), { undo: 0, redo: 1 });
    const r = deps.undo.redo(ctx);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(canon(st.ws), canon(ws1), 'после «Вернуть» — как после действия');
    assert.equal(hash_of(st.ws), ih1);
    assert.equal(deps.undo.undo(ctx).ok, true, 'и снова отмена');
    assert.equal(canon(st.ws), canon(ws0));
    assert.equal(hash_of(st.ws), ih0);
    if (journal_exact) assert.equal(j.state_hash(), hash0);
  });
}

test('TST-16 REQ-090 set_wave_override: правка с тем же id (уходит в конец) и снятие правки из середины — «Отменить» возвращает порядок применения, inputs_hash прежний; журнал только дописывается', (t) => {
  let w = clone(G);
  for (const [id, a, b] of [['wov_a', '2026-10-01', '2026-10-03'], ['wov_b', '2026-10-02', '2026-10-04'], ['wov_c', '2026-10-03', '2026-10-05']]) {
    const r = apply_edit(w, { type: 'set_wave_override', override: { override_id: id, action: 'pin', event_ids: ['tx-g001-01'], pin_range: { from: a, to: b } } }, {});
    assert.equal(r.ok, true, JSON.stringify(r.error));
    w = r.ws;
  }
  reset(w);
  const ws0 = st.ws;
  const ih0 = hash_of(ws0);
  const j = ctx.journal;
  const n0 = j.length;
  const prefix0 = j.prefix_hash(n0);
  const hash0 = j.state_hash();
  ed({ type: 'set_wave_override', override: { override_id: 'wov_a', action: 'pin', event_ids: ['tx-g001-01'], pin_range: { from: '2026-10-01', to: '2026-10-09' } } });
  assert.deepEqual(st.ws.wave_overrides.map((o) => o.override_id), ['wov_b', 'wov_c', 'wov_a'], 'правка ушла в конец списка');
  ed({ type: 'set_wave_override', override_id: 'wov_b', remove: true });
  assert.deepEqual(st.ws.wave_overrides.map((o) => o.override_id), ['wov_c', 'wov_a']);
  assert.deepEqual(deps.undo.size(), { undo: 2, redo: 0 });
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.deepEqual(st.ws.wave_overrides.map((o) => o.override_id), ['wov_b', 'wov_c', 'wov_a'], 'снятая правка вернулась на второе место');
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(canon(st.ws), canon(ws0), 'порядок применения как был: a, b, c');
  assert.equal(hash_of(st.ws), ih0);
  assert.equal(j.prefix_hash(n0), prefix0, 'журнал только дописывается');
  assert.ok(j.length > n0);
  t.diagnostic(`state_hash журнала после двух отмен ${j.state_hash() === hash0 ? 'равен' : 'не равен'} хэшу до действий (у правок волн в состоянии журнала есть seq записи)`);
  assert.equal(deps.undo.redo(ctx).ok, true);
  assert.equal(deps.undo.redo(ctx).ok, true);
  assert.deepEqual(st.ws.wave_overrides.map((o) => o.override_id), ['wov_c', 'wov_a']);
});

test('TST-16 REQ-090: подпись действия в кнопках — по виду правки (настройка, «Сегодня», правило, сценарий…) и с суммой у фактов; пользовательских названий в подписи нет', () => {
  reset();
  const label_of = () => unit_label(deps.undo.peek_undo(), (k, p) => ctx.tr(k, p), (m, c) => `${m / 100} ${c}`);
  const cases = [
    [{ type: 'set_param', key: 'buffer_minor', value: 61000 }, 'изменение настройки'],
    [{ type: 'set_as_of', date: '2026-10-05' }, 'смена даты «Сегодня»'],
    [{ type: 'upsert_rule', rule: RULE_NEW }, 'изменение правила платежа'],
    [{ type: 'save_scenario', scenario: { scenario_id: 'scn-x', name: 'Секретное имя', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 3 }] } }, 'изменение сценария'],
    [{ type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-10-05', amount_minor: -1250, tag: 'кофе' } }, 'расход 12.5 EUR'],
    [{ type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-10-05', amount_minor: 5000, tag: 'возврат', kind: 'income' } }, 'приход 50 EUR'],
    [{ type: 'void_fact', event_id: 'tx-g001-02' }, 'удаление записи'],
    [{ type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-10-05', amount_minor: 400100 } }, 'сверка остатка 4001 EUR'],
    [{ type: 'add_counterparty', counterparty: { name: 'Контрагент Икс' } }, 'добавление контрагента'],
  ];
  for (const [edit, label] of cases) {
    ed(edit);
    assert.equal(N(label_of()), label, edit.type);
  }
  // перевод: две ноги — одна единица «перевод …»
  ed({ type: 'upsert_account', account: { account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR' } });
  ed({ type: 'add_fact', transfer_id: 'trf-1', legs: [{ account_id: 'acc_main', date: '2026-10-05', amount_minor: -20000 }, { account_id: 'acc_sav', date: '2026-10-05', amount_minor: 20000 }] });
  assert.equal(N(label_of()), 'перевод 200 EUR');
  // неизвестная причина записи — вид по изменённой корзине
  const r = apply_edit(st.ws, { type: 'set_param', key: 'horizon_days', value: 33 }, {});
  assert.equal(ctx.set_ws(r.ws, { reason: 'что-то_новое' }).ok, true);
  assert.equal(N(label_of()), 'изменение настройки');
  // вызывающий сам описал действие — описание берётся как есть
  const r2 = apply_edit(st.ws, { type: 'set_param', key: 'horizon_days', value: 34 }, {});
  assert.equal(ctx.set_ws(r2.ws, { reason: 'x', meta: { kind: 'income', amount_minor: 700, currency: 'EUR' } }).ok, true);
  assert.equal(N(label_of()), 'приход 7 EUR');
});

// ── 4. один шаг — одна единица (несколько корзин) ───────────────────────────────────────────────────────────────────────

test('TST-16 REQ-090: правка в нескольких корзинах — одна единица: delete_rule убирает правило и его пропуски вхождений; форма «счёт + остаток» пишет счёт и якорь; настройки пишутся пачкой', () => {
  reset();
  ed({ type: 'set_occurrence_override', override: { rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'skip' } });
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 });
  const before_delete = st.ws;
  const wsd = apply_edit(st.ws, { type: 'delete_rule', rule_id: 'R-RENT' }, {}).ws;
  assert.deepEqual([...new Set(diff_unit(before_delete, wsd, {}).changes.map((c) => c.bucket))].sort(), ['overrides', 'rules']);
  ed({ type: 'delete_rule', rule_id: 'R-RENT' });
  assert.deepEqual(deps.undo.size(), { undo: 2, redo: 0 }, 'удаление правила вместе с пропуском — одна единица');
  assert.equal(st.ws.rules.some((r) => r.rule_id === 'R-RENT'), false);
  assert.equal(st.ws.overrides.length, 0);
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(canon(st.ws), canon(before_delete), 'вернулись и правило, и пропуск');
  // форма «счёт + остаток» (FP-08): два вида правок в одной записи
  reset();
  const ws0 = st.ws;
  const acc = { type: 'upsert_account', account: { account_id: 'acc_card', name: 'Карта', kind: 'bank', liquidity: 'operating', currency: 'EUR' } };
  const anc = { type: 'set_anchor', anchor: { account_id: 'acc_card', date: ws0.as_of, amount_minor: 12345 } };
  const c = commit_edits(ctx, [acc, anc], 'upsert_account');
  assert.equal(c.ok, true, JSON.stringify(c.error));
  assert.equal(st.ws.accounts.length, ws0.accounts.length + 1);
  assert.equal(st.ws.anchors.length, ws0.anchors.length + 1);
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 }, 'счёт и якорь — одна единица');
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(canon(st.ws), canon(ws0));
  // форма настроек (FP-03): несколько параметров — одна запись
  reset();
  const s0 = st.ws;
  const sv = save_edits(ctx, [{ type: 'set_param', key: 'buffer_minor', value: 70000 }, { type: 'set_param', key: 'horizon_days', value: 45 }, { type: 'set_param', key: 'worse.income_delay_days', value: 21 }]);
  assert.equal(sv.ok, true, JSON.stringify(sv.error));
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 });
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(canon(st.ws), canon(s0));
  assert.equal(hash_of(st.ws), hash_of(s0));
});

// ── 5. конфликты, исключённые причины, двойная запись ──────────────────────────────────────────────────────────────────

test('TST-16 REQ-090: конфликт — после действия данные изменены помимо стопки: отмена отказывает (undo_conflict), данные не тронуты, единица снята; то же для параметров, метаполей и правил', () => {
  const cases = [
    ['параметр', { type: 'set_param', key: 'buffer_minor', value: 60000 }, { type: 'set_param', key: 'buffer_minor', value: 70000 }, 'params'],
    ['метаполе «Сегодня»', { type: 'set_as_of', date: '2026-10-05' }, { type: 'set_as_of', date: '2026-10-06' }, 'meta'],
    ['правило', { type: 'upsert_rule', rule: RULE_NEW }, { type: 'upsert_rule', rule: { ...RULE_NEW, amount: { exp_minor: -3500 } } }, 'rules'],
    ['сценарий', { type: 'save_scenario', scenario: { scenario_id: 'scn-c', name: 'А', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 1 }] } }, { type: 'delete_scenario', scenario_id: 'scn-c' }, 'scenarios'],
  ];
  for (const [label, mine, other, bucket] of cases) {
    reset();
    ed(mine);
    foreign(other);
    const ws_foreign = st.ws;
    const r = deps.undo.undo(ctx);
    assert.equal(r.ok, false, label);
    assert.equal(r.error.ctx.reason, 'undo_conflict', label);
    assert.equal(r.error.ctx.bucket, bucket, label);
    assert.equal(st.ws, ws_foreign, label + ': данные не тронуты');
    assert.deepEqual(deps.undo.size(), { undo: 0, redo: 0 }, label + ': устаревшая единица снята со стопки без записи');
  }
});

test('TST-16 REQ-090: исключённые причины в стопку не пишутся — import, import_rollback, undo, redo, служебные перерисовки; restore и adopt очищают стопку; прежние единицы после импорта остаются валидными', () => {
  reset();
  const bump = (v) => apply_edit(st.ws, { type: 'set_param', key: 'horizon_days', value: v }, {}).ws;
  for (const [i, reason] of ['import', 'import_rollback', 'undo', 'redo', 'undo_refresh', 'guard_answer'].entries()) {
    assert.equal(ctx.set_ws(bump(40 + i), { reason }).ok, true);
    assert.deepEqual(deps.undo.size(), { undo: 0, redo: 0 }, `причина «${reason}» не пишется`);
  }
  // действие пользователя, затем «импорт» чужих данных: единица остаётся валидной и отменяет только своё
  reset();
  ed({ type: 'set_param', key: 'buffer_minor', value: 61000 });
  const imported_ws = foreign({ type: 'add_fact', fact: { event_id: 'tx-imp-1', account_id: 'acc_main', date: '2026-10-01', amount_minor: -700, tag: 'импорт' } });
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 }, 'импорт стопку не тронул');
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(st.ws.params.buffer_minor, 50000, 'настройка отменена');
  assert.ok(st.ws.facts.some((f) => f.event_id === 'tx-imp-1'), 'импортированный факт остался');
  assert.equal(st.ws.facts.length, imported_ws.facts.length);
  assert.equal(deps.undo.redo(ctx).ok, true);
  assert.equal(st.ws.params.buffer_minor, 61000);
  // откат партии вынес то же, что отменяла единица — честный конфликт, а не порча данных
  reset();
  ed({ type: 'add_fact', fact: { event_id: 'tx-mine', account_id: 'acc_main', date: '2026-10-02', amount_minor: -100 } });
  foreign({ type: 'void_fact', event_id: 'tx-mine' });
  const r = deps.undo.undo(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error.ctx.reason, 'undo_conflict');
  // restore очищает обе стопки
  reset();
  ed({ type: 'set_param', key: 'buffer_minor', value: 62000 });
  deps.undo.undo(ctx);
  ed({ type: 'set_param', key: 'buffer_minor', value: 63000 });
  ed({ type: 'set_param', key: 'buffer_minor', value: 64000 });
  deps.undo.undo(ctx);
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 1 });
  assert.equal(ctx.set_ws(clone(st.ws), { reason: 'restore' }).ok, true);
  assert.deepEqual(deps.undo.size(), { undo: 0, redo: 0 }, 'замена набора целиком очищает стопку');
  // смена набора данных тоже
  ed({ type: 'set_param', key: 'buffer_minor', value: 65000 });
  assert.equal(deps.undo.size().undo, 1);
  e.reset(clone(G));
  assert.deepEqual(deps.undo.size(), { undo: 0, redo: 0 });
});

test('TST-16 REQ-090: двойной записи нет — «+ Факт», сверка остатка и ответ о переводе записываются стопкой FP-04 до общего пути и помечены undo: recorded; одна правка через ctx.edit — одна единица', () => {
  reset();
  const c = commit_entry(ctx, prepare_entry(st.ws, { kind: 'expense', amount_text: '12,50', account_id: 'acc_main' }, { lang: 'ru', new_id: ctx.new_id }), undefined, deps);
  assert.equal(c.ok, true, JSON.stringify(c.error));
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 }, 'один «+ Факт» = одна единица (а не две)');
  const rec = infos.filter((i) => i.reason === 'add_fact');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].undo, UNDO_RECORDED, 'признак «уже записано» дошёл до подписчиков');
  assert.equal(canon(rec[0].before), canon(G), 'подписчик видит рабочую область «до»');
  assert.equal(rec[0].ws, st.ws);
  assert.deepEqual(deps.undo.peek_undo(), { kind: 'expense', amount_minor: 1250, currency: 'EUR' }, 'подпись FP-04 сохранена');
  // сверка остатка
  reset();
  const a = anchor_confirm(ctx, { account_id: 'acc_main', amount_text: '3 950,00', date: st.ws.as_of }, deps);
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 });
  assert.equal(deps.undo.peek_undo().kind, 'anchor');
  assert.equal(infos.find((i) => i.reason === 'set_anchor').undo, UNDO_RECORDED);
  // ответ о переводе, записанном из файла: резерв уменьшается — одна единица
  const w = clone(G);
  w.accounts.push({ account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  const posted = apply_edit(w, { type: 'add_fact', transfer_id: 'trf_file', legs: [{ account_id: 'acc_main', date: '2026-10-04', amount_minor: -40000 }, { account_id: 'acc_sav', date: '2026-10-04', amount_minor: 40000 }] }, { new_id: ctx.new_id });
  assert.equal(posted.ok, true, JSON.stringify(posted.error));
  reset(posted.ws);
  const alloc = { transfer_id: 'trf_file', reduce_total_minor: 10000, currency: 'EUR', allocations: [{ allocation_id: 'alc-x1', reserve_id: 'RES-INS', date: '2026-10-04', amount_minor: -10000, source: 'manual' }] };
  const pend = resolve_pending(ctx, alloc, 'reduce', deps);
  assert.equal(pend.ok, true, JSON.stringify(pend.error));
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 });
  assert.equal(infos.find((i) => i.reason === 'record_allocation').undo, UNDO_RECORDED);
  // обычная правка через ctx.edit: признака нет, единица одна, подписчик получил before и meta
  reset();
  const m = { kind: 'settings' };
  ed({ type: 'set_param', key: 'buffer_minor', value: 60000 }, { meta: m });
  assert.equal(deps.undo.size().undo, 1);
  assert.equal(infos[0].undo, null);
  assert.equal(infos[0].meta, m, 'описание действия дошло до подписчиков как есть');
  assert.equal(canon(infos[0].before), canon(G));
  assert.equal(infos[0].reason, 'set_param');
  assert.deepEqual(deps.undo.peek_undo(), m);
  // без FP-04-стопки в deps (нет deps.undo) запись всё равно попадает в общую единицу: `rec` пуст, признак не ставится
  reset();
  const c2 = commit_entry(ctx, prepare_entry(st.ws, { kind: 'expense', amount_text: '3', account_id: 'acc_main' }, { lang: 'ru', new_id: ctx.new_id }), undefined, {});
  assert.equal(c2.ok, true);
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 }, 'нет своей стопки — действие записывает общий подписчик');
  assert.equal(infos.find((i) => i.reason === 'add_fact').undo, null);
});

test('TST-16 REQ-090: auto_record — не пишет без «до»/«после», без разницы и с исключёнными причинами; нераспознаваемая разность очищает стопку, а не роняет страницу', () => {
  const stack = create_undo_stack();
  const w0 = clone(G);
  const w1 = { ...w0, params: { ...w0.params, horizon_days: 31 } };
  assert.equal(auto_record(stack, null), false);
  assert.equal(auto_record(stack, { reason: 'set_param', ws: w1 }), false, 'нет рабочей области «до»');
  assert.equal(auto_record(stack, { reason: 'set_param', ws: w0, before: w0 }), false, 'разницы нет');
  assert.equal(auto_record(stack, { reason: 'import', ws: w1, before: w0 }), false);
  assert.equal(auto_record(stack, { reason: 'set_param', ws: w1, before: w0, undo: UNDO_RECORDED }), false);
  assert.equal(stack.size().undo, 0);
  assert.equal(auto_record(stack, { reason: 'set_param', ws: w1, before: w0 }), true);
  assert.deepEqual(stack.peek_undo(), { kind: 'settings' });
  // число с дробью в значении: канон его не принимает — разность строится осторожно (изменение считается изменением), исключения нет
  const bad = { ...w1, params: { ...w1.params, horizon_days: 31.5 } };
  assert.doesNotThrow(() => diff_unit(w1, bad, {}));
  assert.equal(diff_unit(w1, bad, {}).changes.length, 1);
  // разность построить нельзя вовсе (рабочая область бросает при чтении): стопка очищается, страница не падает
  const boom = { ...w1 };
  Object.defineProperty(boom, 'rules', { get() { throw new Error('boom'); }, enumerable: true });
  assert.equal(stack.size().undo, 1);
  assert.doesNotThrow(() => auto_record(stack, { reason: 'set_param', ws: w0, before: boom }));
  assert.deepEqual(stack.size(), { undo: 0, redo: 0 });
  assert.equal(describe_unit('set_param', { changes: [] }, w1).kind, 'settings');
});

test('TST-16 REQ-090: новое действие очищает «Вернуть»; отказ страницы при отмене возвращает единицу; предел 50 — 55 правок оставляют последние 50 и отменяются до 5-й', () => {
  reset();
  ed({ type: 'set_param', key: 'buffer_minor', value: 61000 });
  deps.undo.undo(ctx);
  assert.equal(deps.undo.can_redo(), true);
  ed({ type: 'set_param', key: 'buffer_minor', value: 62000 });
  assert.equal(deps.undo.can_redo(), false, 'новое действие очистило «Вернуть»');
  // отказ пересчёта страницей: единица на месте, данные прежние
  const ws_now = st.ws;
  st.refuse = true;
  const r = deps.undo.undo(ctx);
  assert.equal(r.ok, false);
  assert.equal(st.ws, ws_now);
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 });
  st.refuse = false;
  // отказавшая запись в стопку не попадает
  st.refuse = true;
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 63000 }).ok, false);
  st.refuse = false;
  assert.deepEqual(deps.undo.size(), { undo: 1, redo: 0 });
  // предел
  reset();
  const states = [st.ws];
  for (let i = 1; i <= 55; i++) { ed({ type: 'set_param', key: 'buffer_minor', value: 50000 + i * 100 }); states.push(st.ws); }
  assert.equal(deps.undo.size().undo, 50, 'стопка помнит последние 50 действий');
  for (let i = 0; i < 50; i++) assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(canon(st.ws), canon(states[5]), 'отменено 50 действий — осталось пять прежних');
  assert.equal(deps.undo.undo(ctx).error.ctx.reason, 'nothing_to_undo');
  assert.equal(deps.undo.size().redo, 50);
});

test('TST-16 REQ-090: страница перерисовывается ВНУТРИ записи — к этому моменту единица уже в стопке (кнопка «Отменить» видна сразу); отмена: «Вернуть» доступна уже при перерисовке', () => {
  reset();
  const seen = [];
  st.probe = () => seen.push([deps.undo.can_undo(), deps.undo.can_redo()]);
  ed({ type: 'set_param', key: 'buffer_minor', value: 60500 });
  assert.deepEqual(seen, [[true, false]]);
  seen.length = 0;
  deps.undo.undo(ctx);
  assert.deepEqual(seen, [[false, true]]);
});

// ── слой Б: настоящий app.mjs на заглушке DOM ──────────────────────────────────────────────────────────────────────────


const rctx = ext.ctx;
const nav_button = (label) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && n.textContent === label)[0];
const text_of = (id) => N(byid.get(id).textContent);
const click = (n) => n.listeners.click[0]();
const submit = (form) => form.listeners.submit[0]({ preventDefault() {} });
const lang_button = (code) => find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === code)[0];
/** Набор данных подменяется целиком (как «Продолжить с сохранённого»): стопка и журнал пересоздаются. */
const fresh = () => { const r = rctx.adopt(clone(G), { source: 'test' }); assert.equal(r.ok, true); };

test('TST-16 REQ-090 в настоящем app.mjs: кнопки «Отменить» / «Вернуть» — доступность и подпись aria-label на RU и EN; настройка отменяется и возвращается', () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp04' && d.status === 'ok'));
  fresh();
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), true, 'отменять нечего');
  assert.equal(nav_button('Вернуть').hasAttribute('disabled'), true);
  const ih0 = rctx.get_model().ctx.inputs_hash;
  const ws0 = rctx.get_ws();
  assert.equal(rctx.edit({ type: 'set_param', key: 'buffer_minor', value: 60000 }).ok, true);
  assert.equal(rctx.get_model().ctx.buffer_minor, 60000, 'страница пересчитана');
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), false, 'правка настройки появилась в стопке сразу после записи');
  assert.equal(N(nav_button('Отменить').attrs['aria-label']), 'Отменить последнее действие: изменение настройки');
  assert.equal(nav_button('Вернуть').hasAttribute('disabled'), true);
  // английский язык: подписи кнопок и действия
  click(lang_button('en'));
  assert.equal(N(nav_button('Undo').attrs['aria-label']), 'Undo the last action: settings change');
  assert.equal(nav_button('Redo').hasAttribute('disabled'), true);
  click(nav_button('Undo'));
  assert.equal(rctx.get_ws().params.buffer_minor, 50000, 'настройка отменена кнопкой');
  assert.equal(canon(rctx.get_ws()), canon(ws0));
  assert.equal(rctx.get_model().ctx.inputs_hash, ih0, 'входы расчёта как до правки');
  assert.equal(nav_button('Undo').hasAttribute('disabled'), true);
  assert.equal(nav_button('Redo').hasAttribute('disabled'), false);
  assert.equal(N(nav_button('Redo').attrs['aria-label']), 'Redo the undone action: settings change');
  click(nav_button('Redo'));
  assert.equal(rctx.get_model().ctx.buffer_minor, 60000);
  click(lang_button('ru'));
  assert.equal(nav_button('Вернуть').hasAttribute('disabled'), true, 'возвращать нечего после «Вернуть»');
  assert.equal(N(nav_button('Отменить').attrs['aria-label']), 'Отменить последнее действие: изменение настройки', 'русская подпись вернулась вместе с языком');
});

test('TST-16 REQ-090 в настоящем app.mjs: «Сегодня», формат чисел, сценарий, правило, контрагент и правка волн отменяются кнопкой — побайтно и с тем же inputs_hash', () => {
  const steps = [
    [{ type: 'set_as_of', date: '2026-10-05' }, 'смена даты «Сегодня»'],
    [{ type: 'set_number_format', number_format: { decimal: '.', thousands: ',' } }, 'изменение настройки'],
    [{ type: 'save_scenario', scenario: { scenario_id: 'scn-boot', name: 'Проверка', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 4 }] } }, 'изменение сценария'],
    [{ type: 'upsert_rule', rule: RULE_NEW }, 'изменение правила платежа'],
    [{ type: 'add_counterparty', counterparty: { counterparty_id: 'cp_boot', name: 'ИП Проверка' } }, 'добавление контрагента'],
    [{ type: 'set_wave_override', override: { override_id: 'wov_boot', action: 'pin', event_ids: ['tx-g001-01'], pin_range: { from: '2026-10-01', to: '2026-10-03' } } }, 'правка волн платежей'],
  ];
  for (const [edit, label] of steps) {
    fresh();
    const ws0 = rctx.get_ws();
    const ih0 = rctx.get_model().ctx.inputs_hash;
    assert.equal(rctx.edit(edit).ok, true, edit.type);
    const ws1 = rctx.get_ws();
    assert.notEqual(canon(ws1), canon(ws0), edit.type);
    assert.equal(N(nav_button('Отменить').attrs['aria-label']), 'Отменить последнее действие: ' + label, edit.type);
    click(nav_button('Отменить'));
    assert.equal(canon(rctx.get_ws()), canon(ws0), edit.type + ': побайтно как до действия');
    assert.equal(rctx.get_model().ctx.inputs_hash, ih0, edit.type + ': inputs_hash как до действия');
    assert.equal(nav_button('Отменить').hasAttribute('disabled'), true, edit.type);
    click(nav_button('Вернуть'));
    assert.equal(canon(rctx.get_ws()), canon(ws1), edit.type + ': «Вернуть» — как после действия');
  }
});

test('TST-58 TST-16 REQ-090 в настоящем app.mjs: один «+ Факт» — одна единица (одна отмена убирает факт, и «Отменить» после этого недоступна); удаление факта и правка настроек — отдельные единицы по порядку', () => {
  fresh();
  const ws0 = rctx.get_ws();
  click(nav_button('+ Факт'));
  const form = byid.get('dlg-body').children[0];
  find_all(form, (n) => n.attrs.id === 'entry-amount')[0].value = '12,50';
  submit(form);
  assert.equal(rctx.get_ws().facts.length, ws0.facts.length + 1);
  assert.equal(rctx.edit({ type: 'set_param', key: 'buffer_minor', value: 62000 }).ok, true);
  assert.equal(rctx.edit({ type: 'void_fact', event_id: ws0.facts[3].event_id }).ok, true);
  click(nav_button('Отменить')); // удаление факта
  assert.equal(rctx.get_ws().facts.length, ws0.facts.length + 1);
  assert.equal(rctx.get_ws().facts[3].event_id, ws0.facts[3].event_id, 'факт вернулся на прежнее место');
  click(nav_button('Отменить')); // настройка
  assert.equal(rctx.get_ws().params.buffer_minor, 50000);
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), false, 'ввод факта ещё в стопке');
  click(nav_button('Отменить')); // факт
  assert.equal(canon(rctx.get_ws()), canon(ws0), 'последняя единица — именно один «+ Факт» (а не две)');
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), true, 'двойной записи нет: стопка пуста');
  assert.equal(nav_button('Вернуть').hasAttribute('disabled'), false);
});

test('TST-16 REQ-090 в настоящем app.mjs: запись мастера импорта (reason import) в стопку не попадает, а замена набора (restore) очищает «Отменить / Вернуть»', () => {
  fresh();
  assert.equal(rctx.edit({ type: 'set_param', key: 'horizon_days', value: 40 }).ok, true);
  const r = apply_edit(rctx.get_ws(), { type: 'add_fact', fact: { event_id: 'tx-boot-imp', account_id: 'acc_main', date: '2026-10-01', amount_minor: -500 } }, { new_id: rctx.new_id });
  assert.equal(rctx.set_ws(r.ws, { reason: 'import' }).ok, true);
  click(nav_button('Отменить'));
  assert.equal(rctx.get_ws().params.horizon_days, 57, 'отменена своя настройка');
  assert.ok(rctx.get_ws().facts.some((f) => f.event_id === 'tx-boot-imp'), 'импортированное осталось');
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), true, 'импорт отдельной единицей не стал');
  assert.equal(rctx.set_ws(rctx.get_ws(), { reason: 'restore' }).ok, true);
  assert.equal(nav_button('Вернуть').hasAttribute('disabled'), true, 'restore очистил и «Вернуть»');
});
