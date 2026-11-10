// fp17_fix2.test.mjs — второй круг исправлений FP-17 (повторная независимая проверка).
// В1 (high): исправление первого круга сломало зелёный тест waves_card «строки хуков приложения» (26 строк со словом ext при пределе 25):
//            признак «только чтение» в app.mjs берётся ОДНОЙ строкой (ro_now), остальные места пользуются ею.
// С1 (medium): мастер «Старт» (wizard.mjs) в режиме «только чтение» показывал «Не принято (E_SCHEMA): проверьте заполнение полей» —
//            теперь та же понятная причина (ro.refused), что у остальных форм; то же для подтверждения правила на экране «Резервы».
// Заглушка DOM минимальная (как в fp17_adv): проверяется связка настоящего app.mjs ↔ ext.mjs ↔ пакеты. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DEMO = path.join(ROOT, 'demo');

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
const listeners = {};
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
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => {
  const file = fileURLToPath(url);
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const imp = (...p) => import(pathToFileURL(path.join(ROOT, ...p)).href);
const { ext } = await imp('demo', 'ext.mjs');
await imp('demo', 'app.mjs');
const { export_journal_copy, events_of_ws } = await imp('demo', 'data_actions.mjs');
const { canon, format_date, to_epoch_day } = await imp('engine', 'index.mjs');
const { t } = await imp('demo', 'i18n.mjs');
const { error_message } = await imp('demo', 'wizard.mjs');
await new Promise((r) => setTimeout(r, 500));

const RU = (key, p) => t('ru', key, p);
const EN = (key, p) => t('en', key, p);
const N = (x) => String(x).replace(/[  ]/g, ' ');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'g001.json'), 'utf8'));
const main = () => byid.get('main');
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const live = () => N(byid.get('live').textContent);
const click = (n) => n.listeners.click[0]();
const set_lang = (code) => find_all(byid.get('controls'), (n) => n.attrs.lang === code)[0].listeners.click[0]();

/** Копия журнала в формате НОВЕЕ известного (v2 + запись, которую эта версия не читает): открывается «только для просмотра». */
function newer_copy_text(ws = G) {
  const obj = JSON.parse(export_journal_copy(events_of_ws(ws)).text);
  obj.format = 'runway-journal/2';
  obj.engine_version = '0.2.0';
  const last = obj.events.at(-1).seq;
  obj.events.push({ actor: 'user', entity_id: 'tx-next', event_id: 'ev-x2', payload: { account_id: 'acc_main', amount: { currency: 'EUR', minor: -1999 }, date: '2026-10-03' }, recorded_at: '2026-10-05T08:00:00Z', seq: last + 1, type: 'tx.posted', v: 2 });
  return canon(obj);
}

async function open_newer_readonly(ws = G) {
  await go('#data');
  const input = find_all(main(), (n) => n.attrs.id === 'fp05-file')[0];
  const text = newer_copy_text(ws);
  input.files = [{ size: text.length, text: async () => text }];
  input.listeners.change[0]();
  await wait();
  const btn = find_all(byid.get('dlg-body'), (n) => n.tagName === 'button' && n.textContent === 'Открыть только для просмотра')[0];
  assert.ok(btn !== undefined, 'файл читается: предлагается просмотр');
  btn.listeners.click[0]();
  await wait(150);
  assert.notEqual(ext.ctx.read_only(), null, 'режим «только чтение» включён');
}

// ── В1 (high): строки хуков приложения ────────────────────────────────────────────────────────────────────────────────────

test('В1 строки хуков приложения: слов ext в коде app.mjs не больше 25 (предел waves_card не поднят), признак «только чтение» читается одной строкой ro_now, остальные места им пользуются', () => {
  const lines = fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8').split('\n');
  const code = lines.filter((l) => !/^\s*(\/\/|\*)/.test(l));
  const hook_lines = code.filter((l) => /\bext\b/.test(l)).length;
  assert.ok(hook_lines <= 25, `строк хуков в app.mjs: ${hook_lines}`);
  const direct = code.filter((l) => /ext\.ctx\.read_only\(/.test(l));
  assert.equal(direct.length, 1, 'ext.ctx.read_only() вызывается в одном месте: ' + direct.join(' | '));
  assert.match(direct[0], /^const ro_now = /);
  const users = code.filter((l) => /\bro_now\(\)/.test(l) && !/^const ro_now = /.test(l));
  assert.ok(users.length >= 3, 'ro_now() используют кнопка «Выгрузить JSON», export_state и плашка: ' + users.length);
});

// ── С1 (medium): мастер «Старт» ───────────────────────────────────────────────────────────────────────────────────────────

test('С1 wizard.error_message: причина read_only даёт ro.refused (RU и EN), без кода и без «проверьте заполнение»; прочие причины — прежние тексты', () => {
  const env = (lang) => ({ cur: 'EUR', lang, nf: undefined, as_of: '2026-10-04' });
  const err = { code: 'E_SCHEMA', ctx: { reason: 'read_only' } };
  for (const [lang, tr, expect] of [['ru', RU, /только для просмотра/], ['en', EN, /viewing only/]]) {
    const x = error_message(tr, err, env(lang));
    assert.equal(x, tr('ro.refused'));
    assert.match(x, expect);
    assert.doesNotMatch(x, /E_SCHEMA|проверьте|check the/);
  }
  // ничего лишнего не затронуто: тот же код без причины read_only и другие причины
  assert.equal(error_message(RU, { code: 'E_SCHEMA', ctx: null }, env('ru')), RU('start.er_other', { code: 'E_SCHEMA' }));
  assert.match(error_message(RU, { code: 'E_NOT_INTEGER', ctx: { field: 'amount', reason: 'zero' } }, env('ru')), /сумма не может быть нулём/);
  assert.notEqual(error_message(EN, { code: 'E_SCHEMA', ctx: { reason: 'zero', field: 'amount' } }, env('en')), EN('ro.refused'));
});

test('С1 мастер «Старт» в настоящем приложении, режим «только чтение»: «Сохранить буфер» с верным значением и «Сохранить счёт» — в форме ro.refused, данные не тронуты, кода E_SCHEMA нет', async () => {
  await open_newer_readonly();
  await go('#start');
  const ws_before = ext.ctx.get_ws();
  const before = canon(ws_before);
  const status_of = () => find_all(main(), (n) => n.tagName === 'p' && /\bstart-status\b/.test(n.className)).map((n) => N(n.textContent)).join(' ');
  // шаг «Буфер»
  click(find_all(main(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'buffer')[0]);
  by_id('st-buf-amount').value = '500';
  by_id('st-form-buf').listeners.submit[0]({ preventDefault() {} });
  await wait(30);
  assert.equal(status_of(), N(RU('ro.refused')), 'в форме — причина отказа');
  assert.doesNotMatch(N(main().textContent), /E_SCHEMA|проверьте заполнение/, 'на странице нет ложной причины и кода');
  assert.equal(live(), N(RU('ro.refused')), 'и центральное уведомление то же');
  assert.equal(ext.ctx.get_ws(), ws_before, 'рабочая область — тот же объект');
  assert.equal(canon(ext.ctx.get_ws()), before);
  // шаг «Счёт и остаток» с верными значениями
  click(find_all(main(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'account')[0]);
  by_id('st-acc-name').value = 'Основной';
  by_id('st-acc-balance').value = '1 000,00';
  by_id('st-form-acc').listeners.submit[0]({ preventDefault() {} });
  await wait(30);
  assert.equal(status_of(), N(RU('ro.refused')));
  assert.doesNotMatch(N(main().textContent), /E_SCHEMA|проверьте заполнение/);
  assert.equal(canon(ext.ctx.get_ws()), before, 'данные не тронуты');
  assert.notEqual(ext.ctx.read_only(), null, 'просмотр не снят');
});

test('С1 то же по-английски: форма «Буфер» показывает English-текст ro.refused', async () => {
  set_lang('en');
  try {
    await go('#start');
    click(find_all(main(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'buffer')[0]);
    by_id('st-buf-amount').value = '500';
    by_id('st-form-buf').listeners.submit[0]({ preventDefault() {} });
    await wait(30);
    const status = find_all(main(), (n) => n.tagName === 'p' && /\bstart-status\b/.test(n.className)).map((n) => N(n.textContent)).join(' ');
    assert.equal(status, N(EN('ro.refused')));
    assert.doesNotMatch(N(main().textContent), /E_SCHEMA/);
  } finally { set_lang('ru'); }
});

test('В1 экран «Данные» в просмотре после правки app.mjs: «Выгрузить JSON» отключена и связана с плашкой, нажатие (в обход disabled) отказывает с пояснением', async () => {
  await go('#data');
  const btns = find_all(main(), (n) => n.tagName === 'button' && n.textContent === 'Выгрузить JSON');
  assert.equal(btns.length, 1);
  assert.ok(btns[0].hasAttribute('disabled'), 'отключена');
  assert.equal(btns[0].attrs['aria-describedby'], 'fp05-ro-note');
  btns[0].listeners.click[0]();
  await wait(30);
  assert.match(N(main().textContent), /Копию журнала и выгрузку JSON из просмотра сделать нельзя/, 'пояснение вместо выгрузки');
});

// ── С1: то же для подтверждения правила на экране «Резервы» ────────────────────────────────────────────────────────────────

test('С1 «Резервы» в режиме «только чтение»: «Подтвердить правило» называет причину ro.refused, а не «Правило не подтверждено (код E_SCHEMA)»; правило не меняется', async () => {
  const ws = clone(G);
  ws.tax_rules[0].reviewed_at = format_date(to_epoch_day(ws.as_of) - 86);
  ws.tax_rules[0].ttl_days = 60;
  await open_newer_readonly(ws);
  await go('#reserves');
  const confirm = by_id('fp15-rule-0-confirm');
  assert.ok(confirm !== undefined, 'правило устарело: кнопка «Подтвердить правило» на месте');
  const rules_before = canon(ext.ctx.get_ws().tax_rules);
  click(confirm);
  await wait(30);
  assert.equal(live(), N(RU('ro.refused')), 'последнее сообщение — причина, а не код');
  assert.doesNotMatch(live(), /E_SCHEMA|не подтверждено \(код/);
  assert.equal(canon(ext.ctx.get_ws().tax_rules), rules_before, 'правило не изменилось');
});

// ── выход из просмотра: тот же ввод проходит ───────────────────────────────────────────────────────────────────────────────

test('С1 после выхода из просмотра (выбор набора данных) тот же буфер 500 в мастере «Старт» записывается, ro.refused не показывается', async () => {
  const select = find_all(byid.get('controls'), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
  await select.listeners.change[0]({ target: { value: 'g001' } });
  await wait(100);
  assert.equal(ext.ctx.read_only(), null, 'просмотр снят');
  await go('#start');
  click(find_all(main(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'buffer')[0]);
  by_id('st-buf-amount').value = '500';
  by_id('st-form-buf').listeners.submit[0]({ preventDefault() {} });
  await wait(30);
  assert.equal(ext.ctx.get_ws().params.buffer_minor, 50000, 'буфер записан');
  assert.doesNotMatch(N(main().textContent), /только для просмотра/);
  assert.notEqual(live(), N(RU('ro.refused')));
});
