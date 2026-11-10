// calendar_form.test.mjs — FP-13 (волна 3а) в настоящем app.mjs на заглушке DOM: пакет pack_fp13 подхвачен манифестом; экран «Формы данных» → «Платежи» получает выбор календаря,
// поле «n-й рабочий день», действия «Перенести» и «Другая сумма» у вхождения, карточки «Разовый платёж» и «Календарь выходных и праздников». Запись идёт общим путём
// (ctx.set_ws → пересчёт страницы → журнал), «Отменить» откатывает, отказы называют код канона и не повторяют введённое, RU и EN, подписи полей, aria-live, фокус.
// Браузер, сервер и сеть не используются. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/calendar_form.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.focused = false;
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
  append(...kids) { for (const k of kids) { this.children.push(k); if (k.nodeType === 1) k.parent = this; } this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parent !== undefined) this.parent.children = this.parent.children.filter((c) => c !== this); }
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
function find_in(root, id) {
  let hit = null;
  if (root !== undefined) root.walk((n) => { if (hit === null && n.attrs.id === id) hit = n; });
  return hit;
}
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? find_in(byid.get('main'), id) ?? find_in(byid.get('nav'), id), // как в браузере: элемент страницы находится по id в любом месте дерева
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
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // document.getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 700)); // boot асинхронный: пакеты, набор данных, boot-хук

const E = await import('../engine/index.mjs');
const WE = await import(pathToFileURL(path.join(DEMO, 'ws_edit.mjs')).href);
const BR = await import(pathToFileURL(path.join(DEMO, 'ws_bridge.mjs')).href);
const RULE = await import(pathToFileURL(path.join(DEMO, 'form_rule.mjs')).href);
const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);

const NB = /[  ]/g;
const N = (x) => String(x).replace(NB, ' ');
const main = () => byid.get('main');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const nav_button = (prefix) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && N(n.textContent).startsWith(prefix))[0];
const click = (n) => { assert.ok(n !== undefined, 'нет узла'); assert.equal(n.hasAttribute('disabled'), false, 'кнопка недоступна: ' + n.attrs.id); n.listeners.click[0](); };
const type_into = (n, value, event = 'input') => { assert.ok(n !== undefined, 'нет поля'); n.value = value; for (const fn of n.listeners[event] ?? []) fn({ target: n }); };
const choose = (n, value) => { assert.ok(n !== undefined, 'нет списка'); n.value = value; for (const fn of n.listeners.change ?? []) fn({ target: n }); };
const check = (id, on) => { const n = by_id(id); assert.ok(n !== undefined, 'нет флажка ' + id); n.checked = on; for (const fn of n.listeners.change ?? []) fn({ target: n }); };
const submit = (id) => { const f = by_id(id); assert.ok(f !== undefined, 'нет формы ' + id); return f.listeners.submit[0]({ preventDefault() {} }); };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const tick = () => new Promise((r) => setTimeout(r, 15));
const ctx = ext.ctx;
const canon = E.canon;
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = JSON.parse(fs.readFileSync(path.join(DATA, 'g001.json'), 'utf8'));
const hash_now = () => ctx.get_model().ctx.inputs_hash;
const notes = () => ext.diagnostics().filter((d) => d.status === 'notify').map((d) => N(d.message));
const status_of = (form_id) => find_all(by_id(form_id), (n) => n.attrs.role === 'status').map((n) => N(n.textContent)).join(' ');
const reset = async (ws = G) => { const r = ctx.adopt(clone(ws), { source: 'test' }); assert.equal(r.ok, true, JSON.stringify(r.error)); await go('#forms'); };
const rule_item = (rule_id) => find_all(main(), (n) => n.attrs['data-rule'] === rule_id)[0];
const row_button = (rule_id, nominal, act) => find_all(rule_item(rule_id), (n) => n.tagName === 'button' && n.attrs['data-act'] === act && n.attrs['data-nominal'] === nominal)[0];
const plan_events = () => ctx.get_model().ctx.events.plan;
const event_date = (id) => E.format_date(plan_events().find((e) => e.cash_event_id === id).date);
const lang_button = (lang) => find_all(byid.get('controls'), (n) => n.attrs.lang === lang)[0];

const RENT = 'R-RENT';
const NOM = '2026-10-25';

test('REQ-009 REQ-010 boot: пакет FP-13 подхвачен манифестом без сбоев; виды правок зарегистрированы; app.mjs пакет не называет; в «Платежи» есть календарь, n-й рабочий день, действия над вхождением и две карточки', async () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp13' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp13')));
  assert.deepEqual(ext.diagnostics().filter((d) => d.status === 'failed'), [], 'ни один пакет не упал');
  for (const t of ['upsert_calendar', 'delete_calendar', 'upsert_plan', 'delete_plan', 'set_occurrence_override']) assert.ok(WE.list_edit_types().includes(t), t);
  assert.ok(!/pack_fp13|form_calendar|form_plan/.test(fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8')), 'app.mjs не знает пакет поимённо');
  await reset();
  assert.equal(N(by_id('view-title').textContent), 'Формы данных');
  assert.equal(find_all(main(), (n) => n.attrs['data-tab'] !== undefined).length, 7, 'число разделов экрана не изменилось');
  const cal = by_id('fp08-rule-calendar_id');
  assert.deepEqual(find_all(cal, (n) => n.tagName === 'option').map((o) => [o.attrs.value, N(o.textContent)]), [['', 'Суббота и воскресенье, без праздников (по умолчанию)'], ['cal-main', 'Суббота и воскресенье']]);
  assert.equal(cal.value, 'cal-main', 'по умолчанию выбран первый календарь рабочей области — видно, какой считается');
  assert.ok(by_id('fp08-rule-workday') !== undefined);
  assert.ok(N(by_id('fp08-rule-workday-hint').textContent).includes('первый рабочий день'));
  for (const id of ['fp13-plans', 'fp13-calendars']) assert.ok(by_id(id) !== undefined, id);
  assert.equal(N(by_id('fp13-plans-title').textContent), 'Разовый платёж');
  assert.equal(N(by_id('fp13-calendars-title').textContent), 'Календарь выходных и праздников');
  assert.ok(N(by_id('fp13-calendars').textContent).includes('Готовых списков праздников по странам в приложении нет'));
  // у каждого вхождения три действия: «Пропустить», «Перенести», «Другая сумма»
  assert.deepEqual(['skip', 'move', 'amount'].map((a) => row_button(RENT, NOM, a)?.tagName), ['button', 'button', 'button']);
  assert.match(N(row_button(RENT, NOM, 'move').attrs['aria-label']), /^Перенести вхождение «Аренда» 26 октября на другую дату$/);
  assert.match(N(row_button(RENT, NOM, 'amount').attrs['aria-label']), /^Другая сумма вхождения «Аренда» 26 октября$/);
  assert.equal(row_button(RENT, NOM, 'move').attrs['aria-expanded'], 'false');
  assert.equal(row_button(RENT, NOM, 'ov-restore'), undefined, 'вернуть нечего');
});

test('a11y FP-13: у каждого поля подпись, описания и места ошибок существуют, идентификаторы уникальны, кнопки имеют имя, без inline-стилей и обработчиков-строк; живые области для предпросмотра', async () => {
  await reset();
  click(row_button(RENT, NOM, 'move'));
  const labels = new Set(find_all(main(), (n) => n.tagName === 'label').map((l) => l.attrs.for));
  const ids = new Set(find_all(main(), (n) => n.attrs.id !== undefined).map((n) => n.attrs.id));
  const all_ids = find_all(main(), (n) => n.attrs.id !== undefined).map((n) => n.attrs.id);
  assert.equal(new Set(all_ids).size, all_ids.length, 'идентификаторы на странице уникальны');
  const bad = [];
  main().walk((n) => {
    if (n.attrs.style !== undefined) bad.push('style');
    if (Object.keys(n.attrs).some((k) => /^on/i.test(k))) bad.push('on*');
    if (['input', 'select', 'textarea'].includes(n.tagName)) {
      if (!labels.has(n.attrs.id) && !n.attrs['aria-label']) bad.push('поле без подписи: ' + n.attrs.id);
      for (const d of String(n.attrs['aria-describedby'] ?? '').split(/\s+/).filter(Boolean)) if (!ids.has(d)) bad.push(`описание ${d} не существует (${n.attrs.id})`);
    }
    if (n.tagName === 'button' && n.textContent.trim() === '' && !n.attrs['aria-label']) bad.push('кнопка без имени');
    if (n.attrs['aria-controls'] !== undefined && !ids.has(n.attrs['aria-controls'])) bad.push('aria-controls ведёт в пустоту: ' + n.attrs['aria-controls']);
  });
  assert.deepEqual(bad, []);
  // видимый текст кнопки — начало доступного имени
  for (const act of ['skip', 'move', 'amount']) {
    const b = row_button(RENT, NOM, act);
    assert.ok(N(b.attrs['aria-label']).startsWith(N(b.textContent)) || N(b.attrs['aria-label']).toLowerCase().startsWith(N(b.textContent).toLowerCase().slice(0, 4)), `${act}: «${b.textContent}» / «${b.attrs['aria-label']}»`);
  }
  assert.equal(by_id('fp13-ov-mv-0-0-preview').attrs['aria-live'], 'polite', 'предпросмотр перемещения читается скринридером');
  for (const id of ['fp08-rule-preview', 'fp08-rule-cal-note', 'fp13-cal-preview', 'fp13-plan-preview']) assert.equal(by_id(id).attrs['aria-live'], 'polite', id);
  assert.equal(by_id('fp13-ov-mv-0-0').attrs['aria-label'] !== undefined, true, 'встроенная форма подписана');
  assert.equal(row_button(RENT, NOM, 'move').attrs['aria-controls'], 'fp13-slot-0-0');
  assert.equal(row_button(RENT, NOM, 'move').attrs['aria-expanded'], 'true');
  for (const id of ['fp08-rule-name-err', 'fp08-cal-name-err', 'fp08-cal-holidays-err', 'fp08-plan-amount-err']) assert.equal(by_id(id).attrs.role, 'alert', id + ': ошибка читается сразу');
});

test('REQ-009 TST-13 форма правила в приложении: «n-й рабочий день» и календарь записываются; «открыть — сохранить без изменений» не теряет поле и не пишет в журнал; правка суммы сохраняет поле', async () => {
  await reset();
  type_into(by_id('fp08-rule-name'), 'Взнос');
  type_into(by_id('fp08-rule-amount'), '100');
  type_into(by_id('fp08-rule-start_date'), '2026-10-01');
  type_into(by_id('fp08-rule-workday'), '3');
  assert.match(N(by_id('fp08-rule-preview').textContent), /5 октября: −100,00 €/, 'предпросмотр: третий рабочий день октября');
  assert.match(N(by_id('fp08-rule-preview').textContent), /4 ноября: −100,00 €/);
  const n0 = ctx.journal.length;
  submit('fp08-rule');
  const rule = ctx.get_ws().rules.at(-1);
  assert.deepEqual([rule.name, rule.by_workday, rule.calendar_id, rule.freq, rule.weekend], ['Взнос', [3], 'cal-main', 'M', 'keep']);
  assert.equal(rule.by_monthday, undefined);
  assert.deepEqual(ctx.journal.events().slice(n0).map((e) => e.type), ['rule.set']);
  await tick();
  assert.equal(by_id('fp08-sec-rules-title').focused, true, 'фокус вернулся на раздел после записи');
  // открыть и сохранить без изменений
  const ws_before = clone(ctx.get_ws());
  click(find_all(rule_item(rule.rule_id), (n) => n.attrs['data-act'] === 'edit')[0]);
  assert.equal(by_id('fp08-rule-workday').value, '3', 'поле заполнено из правила');
  assert.equal(by_id('fp08-rule-calendar_id').value, 'cal-main');
  assert.equal(by_id('fp08-rule-monthday').value, '');
  submit('fp08-rule');
  assert.equal(canon(ctx.get_ws()), canon(ws_before), 'ничего не изменилось');
  assert.equal(ctx.get_ws().rules.at(-1).version, 1);
  assert.equal(ctx.journal.length, n0 + 1, 'повторное сохранение не пишет в журнал');
  // правка суммы: n-й рабочий день на месте, версия повышена
  click(find_all(rule_item(rule.rule_id), (n) => n.attrs['data-act'] === 'edit')[0]);
  type_into(by_id('fp08-rule-amount'), '120');
  submit('fp08-rule');
  const raised = ctx.get_ws().rules.at(-1);
  assert.deepEqual([raised.by_workday, raised.version, raised.amount.exp_minor], [[3], 2, -12000]);
  assert.equal(event_date(rule.rule_id + '@2026-11-04'), '2026-11-04');
  // вместе с днём месяца — отказ с кодом, данные не меняются
  click(find_all(rule_item(rule.rule_id), (n) => n.attrs['data-act'] === 'edit')[0]);
  type_into(by_id('fp08-rule-monthday'), '25');
  const h0 = hash_now();
  submit('fp08-rule');
  assert.match(status_of('fp08-rule'), /Не принято \(E_RULE_INVALID\) «n-й рабочий день месяца»/);
  assert.equal(hash_now(), h0);
  assert.ok(!N(main().textContent).includes('Не принято (E_RULE_INVALID) «n-й рабочий день месяца»: 25'), 'введённое не повторяется');
});

test('REQ-009 политика переноса без календаря: форма называет причину и предлагает создать календарь; кнопка «Создать календарь» ведёт в поле названия; выбор «по умолчанию» тоже объяснён', async () => {
  const none = clone(G);
  none.calendars = [];
  for (const r of none.rules) delete r.calendar_id;
  for (const s of none.streams) delete s.calendar_id;
  await reset(none);
  assert.deepEqual(find_all(by_id('fp08-rule-calendar_id'), (n) => n.tagName === 'option').map((o) => o.attrs.value), ['']);
  assert.equal(N(by_id('fp08-rule-cal-note').textContent), '', 'политика «оставить как есть» — сказать нечего');
  choose(by_id('fp08-rule-weekend'), 'next');
  const note = N(by_id('fp08-rule-cal-note').textContent);
  assert.match(note, /В данных нет календаря: выходными считаются суббота и воскресенье, праздников нет/);
  const make = find_all(by_id('fp08-rule-cal-note'), (n) => n.attrs['data-act'] === 'goto-calendar')[0];
  assert.equal(N(make.textContent), 'Создать календарь');
  click(make);
  assert.equal(by_id('fp08-cal-name').focused, true, 'фокус в поле названия календаря');
  assert.ok(N(by_id('fp13-cal-none').textContent).includes('Календарей пока нет'));
  choose(by_id('fp08-rule-weekend'), 'keep');
  assert.equal(N(by_id('fp08-rule-cal-note').textContent), '');
  type_into(by_id('fp08-rule-workday'), '1');
  assert.match(N(by_id('fp08-rule-cal-note').textContent), /календаря/, 'n-й рабочий день тоже нуждается в календаре');
  // календари есть, но выбран «по умолчанию»
  await reset();
  choose(by_id('fp08-rule-weekend'), 'prev');
  assert.equal(N(by_id('fp08-rule-cal-note').textContent), '', 'календарь выбран — сказать нечего');
  choose(by_id('fp08-rule-calendar_id'), '');
  assert.match(N(by_id('fp08-rule-cal-note').textContent), /Календарь не выбран: выходными считаются суббота и воскресенье, праздников нет\./);
});

test('REQ-010 «Перенести»: встроенная форма с предпросмотром (expand_all) → запись override move общим путём; дата точная; серия не разорвана; журнал override.set; фокус на «Править»; «Отменить» и «Вернуть»', async () => {
  await reset();
  const h0 = hash_now();
  const n0 = ctx.journal.length;
  click(row_button(RENT, NOM, 'move'));
  assert.equal(row_button(RENT, NOM, 'move').attrs['aria-expanded'], 'true');
  const field = by_id('fp08-mv-0-0-move_date');
  assert.equal(field.value, '2026-10-26', 'по умолчанию — текущая дата вхождения');
  assert.match(N(by_id('fp13-ov-mv-0-0-preview').textContent), /Без изменений/);
  type_into(field, '2026-10-28');
  const preview = N(by_id('fp13-ov-mv-0-0-preview').textContent);
  assert.match(preview, /«Аренда»: 26 октября → 28 октября\./);
  assert.match(preview, /Серия не разрывается/);
  assert.match(preview, /28 октября: −900,00 €/);
  assert.match(preview, /25 ноября: −900,00 €/);
  assert.equal(ctx.journal.length, n0, 'до «Применить» ничего не записано');
  submit('fp13-ov-mv-0-0');
  assert.deepEqual(ctx.get_ws().overrides, [{ rule_id: RENT, nominal_date: NOM, action: 'move', date: '2026-10-28' }]);
  assert.equal(event_date('R-RENT@2026-10-25'), '2026-10-28', 'событие прогноза перенесено, идентификатор прежний');
  assert.notEqual(hash_now(), h0);
  assert.deepEqual(ctx.journal.events().slice(n0).map((e) => e.type), ['override.set']);
  assert.ok(notes().some((m) => /Вхождение «Аренда» 26 октября перенесено на 28 октября\. «Отменить» вернёт прежнюю дату\./.test(m)), notes().join(' | '));
  await tick();
  assert.equal(by_id('fp08-rule-edit-0').focused, true, 'фокус вернулся на правило');
  // FP-48: подпись называет дату, которую пользователь видел и выбрал для переноса (26 октября, сдвиг воскресенья на рабочий день), а дата правила — в скобках
  assert.match(N(rule_item(RENT).textContent), /28 октября: −900,00 € · перенесено с 26 октября \(по правилу — 25 октября\)/);
  assert.ok(row_button(RENT, NOM, 'ov-restore') !== undefined, 'есть «Вернуть как по правилу»');
  assert.ok(!N(by_id('fp13-slot-0-0').textContent).includes('Применить'), 'встроенная форма закрыта: страница перерисована');
  // повтор той же правки не пишет вторую запись
  click(row_button(RENT, NOM, 'move'));
  submit('fp13-ov-mv-0-0');
  assert.equal(ctx.journal.length, n0 + 1, 'повторная запись той же даты — без новой записи журнала');
  assert.equal(ctx.get_ws().overrides.length, 1);
  // «Отменить» → прежняя дата, затем «Вернуть»
  const undo = nav_button('Отменить');
  assert.ok(N(undo.attrs['aria-label'] ?? undo.textContent).includes('изменение правила платежа'));
  click(undo);
  assert.deepEqual(ctx.get_ws().overrides, []);
  assert.equal(hash_now(), h0, 'числа вернулись');
  assert.equal(event_date('R-RENT@2026-10-25'), '2026-10-26');
  click(nav_button('Вернуть'));
  assert.equal(event_date('R-RENT@2026-10-25'), '2026-10-28');
  // «Вернуть как по правилу» снимает правку
  click(row_button(RENT, NOM, 'ov-restore'));
  assert.deepEqual(ctx.get_ws().overrides, []);
  assert.equal(hash_now(), h0);
  assert.ok(notes().some((m) => /Вхождение «Аренда» 28 октября снова идёт по правилу\./.test(m)));
});

test('REQ-010 «Другая сумма»: предпросмотр «−900,00 € → −950,00 €», запись set_amount только у этого вхождения; перенос и сумма на одном вхождении заменяют друг друга — форма говорит об этом до нажатия', async () => {
  await reset();
  const h0 = hash_now();
  click(row_button(RENT, NOM, 'amount'));
  const field = by_id('fp08-am-0-0-amount');
  assert.equal(N(field.value), '900', 'по умолчанию — текущая сумма без знака');
  assert.equal(N(by_id('fp08-am-0-0-amount').attrs.id), 'fp08-am-0-0-amount');
  type_into(field, '950');
  const preview = N(by_id('fp13-ov-am-0-0-preview').textContent);
  assert.match(preview, /26 октября: −900,00 € → −950,00 €\./);
  assert.match(preview, /25 ноября: −900,00 €/, 'остальные вхождения по правилу');
  submit('fp13-ov-am-0-0');
  assert.deepEqual(ctx.get_ws().overrides, [{ rule_id: RENT, nominal_date: NOM, action: 'set_amount', amount_minor: -95000 }]);
  const ev = plan_events().filter((e) => e.rule_id === RENT).slice(0, 2);
  assert.deepEqual(ev.map((e) => e.amount_minor), [-95000, -90000]);
  assert.match(N(rule_item(RENT).textContent), /26 октября: −950,00 € · сумма изменена/);
  assert.ok(notes().some((m) => /Вхождение «Аренда» 26 октября: сумма −950,00 € вместо −900,00 €\./.test(m)));
  // перенос поверх своей суммы: форма предупреждает, что прежняя правка будет заменена
  click(row_button(RENT, NOM, 'move'));
  assert.match(N(by_id('fp13-ov-mv-0-0-replaces').textContent), /уже есть своя сумма −950,00 €: перенос заменит её/);
  type_into(by_id('fp08-mv-0-0-move_date'), '2026-10-29');
  submit('fp13-ov-mv-0-0');
  assert.deepEqual(ctx.get_ws().overrides, [{ rule_id: RENT, nominal_date: NOM, action: 'move', date: '2026-10-29' }], 'одна запись на вхождение');
  assert.equal(plan_events().find((e) => e.cash_event_id === 'R-RENT@2026-10-25').amount_minor, -90000, 'сумма вернулась к правилу');
  click(row_button(RENT, NOM, 'amount'));
  assert.match(N(by_id('fp13-ov-am-0-0-replaces').textContent), /уже есть перенос на 29 октября: правка суммы заменит его/);
  click(row_button(RENT, NOM, 'amount')); // повторное нажатие закрывает форму
  assert.equal(by_id('fp13-slot-0-0').children.length, 0);
  assert.equal(row_button(RENT, NOM, 'amount').attrs['aria-expanded'], 'false');
  click(row_button(RENT, NOM, 'ov-restore'));
  assert.equal(hash_now(), h0);
});

test('REQ-010 REQ-017 «Перенести» и «Другая сумма»: отказ называет код и поле, введённое не повторяется, данные и журнал не меняются; «Закрыть» убирает форму и возвращает фокус на кнопку', async () => {
  await reset();
  const h0 = hash_now();
  const n0 = ctx.journal.length;
  click(row_button(RENT, NOM, 'move'));
  type_into(by_id('fp08-mv-0-0-move_date'), '2026-02-30');
  assert.match(N(by_id('fp13-ov-mv-0-0-preview').textContent), /Введите значение/);
  submit('fp13-ov-mv-0-0');
  assert.match(N(by_id('fp08-mv-0-0-move_date-err').textContent), /Не принято \(E_BAD_DATE\) «На дату»/);
  assert.equal(by_id('fp08-mv-0-0-move_date').attrs['aria-invalid'], 'true');
  assert.ok(!N(main().textContent).includes('2026-02-30'), 'введённая дата не повторяется');
  // слишком далёкий перенос отвергает проверка записи
  type_into(by_id('fp08-mv-0-0-move_date'), '2046-10-28');
  submit('fp13-ov-mv-0-0');
  assert.match(N(by_id('fp08-mv-0-0-move_date-err').textContent), /Не принято \(E_BAD_DATE\)/);
  assert.deepEqual(ctx.get_ws().overrides, []);
  assert.equal(ctx.journal.length, n0);
  click(find_all(by_id('fp13-ov-mv-0-0'), (n) => n.attrs['data-act'] === 'ov-close')[0]);
  assert.equal(by_id('fp13-slot-0-0').children.length, 0, 'форма закрыта');
  assert.equal(row_button(RENT, NOM, 'move').focused, true, 'фокус вернулся на кнопку, которая открыла форму');
  click(row_button(RENT, NOM, 'amount'));
  for (const [text, code] of [['abc', 'E_NOT_INTEGER'], ['0', 'E_SCHEMA'], ['', 'E_NOT_INTEGER'], ['99999999999999999999', 'E_OVERFLOW']]) {
    type_into(by_id('fp08-am-0-0-amount'), text);
    submit('fp13-ov-am-0-0');
    assert.match(N(by_id('fp08-am-0-0-amount-err').textContent), new RegExp(`Не принято \\(${code}\\) «Сумма»`), text);
    if (text === 'abc') assert.ok(!N(main().textContent).includes('abc'), 'введённое не повторяется');
  }
  assert.deepEqual(ctx.get_ws().overrides, []);
  assert.equal(hash_now(), h0);
  assert.equal(ctx.journal.length, n0);
});

test('REQ-010 перенесённое вхождение, ушедшее за ближайшие даты, видно отдельной строкой и возвращается «как по правилу»; пропуск по-прежнему вернуть кнопкой «Вернуть»; фокус после действия не теряется', async () => {
  await reset();
  const h0 = hash_now();
  click(row_button(RENT, NOM, 'move'));
  type_into(by_id('fp08-mv-0-0-move_date'), '2027-02-10');
  assert.match(N(by_id('fp13-ov-mv-0-0-preview').textContent), /26 октября → 10 февраля 2027\./);
  submit('fp13-ov-mv-0-0');
  assert.equal(row_button(RENT, NOM, 'skip'), undefined, 'вхождения нет среди ближайших трёх');
  const line = find_all(rule_item(RENT), (n) => n.tagName === 'li' && n.attrs['data-nominal'] === NOM)[0];
  assert.match(N(line.textContent), /Перенесено: 26 октября → 10 февраля 2027 \(по правилу — 25 октября\)/); // FP-48: «с» — показанная до переноса дата, а не дата правила
  const restore = find_all(line, (n) => n.attrs['data-act'] === 'ov-restore')[0];
  assert.match(N(restore.attrs['aria-label']), /^Вернуть как по правилу: вхождение «Аренда» 25 октября$/);
  click(restore);
  assert.deepEqual(ctx.get_ws().overrides, []);
  assert.equal(hash_now(), h0);
  await tick();
  assert.equal(by_id('fp08-rule-edit-0').focused, true);
  // пропуск и возврат пропуска (прежнее поведение)
  click(row_button(RENT, NOM, 'skip'));
  assert.deepEqual(ctx.get_ws().overrides, [{ rule_id: RENT, nominal_date: NOM, action: 'skip' }]);
  assert.match(N(rule_item(RENT).textContent), /Пропущено: 25 октября/);
  click(find_all(rule_item(RENT), (n) => n.attrs['data-act'] === 'restore')[0]);
  assert.equal(hash_now(), h0);
});

test('REQ-009 карточка календаря: список с выходными, числом праздников и тем, кто календарь использует; создание с предпросмотром; календарь влияет на даты правила; удаление нужного — отказ с кодом, свободного — удаление', async () => {
  await reset();
  const card = N(by_id('fp13-calendars').textContent);
  assert.match(card, /Суббота и воскресенье выходные: Сб, Вс; 0 праздников Используют: правил — 4, потоков часов — 1\./);
  const facts0 = canon(ctx.get_ws().facts);
  // отказ: календарь нужен правилам
  const n0 = ctx.journal.length;
  click(find_all(by_id('fp13-calendars'), (n) => n.attrs['data-act'] === 'cal-delete')[0]);
  assert.ok(notes().some((m) => /Не принято \(E_SCHEMA\): календарь нужен правилам или потокам часов/.test(m)), notes().join(' | '));
  assert.equal(ctx.get_ws().calendars.length, 1);
  assert.equal(ctx.journal.length, n0);
  // создание
  type_into(by_id('fp08-cal-name'), 'Праздники');
  type_into(by_id('fp08-cal-holidays'), '2026-10-26, 2026-12-25\n25.12.2026');
  const prev = N(by_id('fp13-cal-preview').textContent);
  assert.match(prev, /Ближайшие нерабочие дни по этому календарю/);
  assert.match(prev, /26 октября: праздник/);
  assert.match(prev, /4 октября: выходной/);
  submit('fp08-cal');
  const cal = ctx.get_ws().calendars.at(-1);
  assert.deepEqual([cal.name, cal.weekend_dows, cal.holidays], ['Праздники', [0, 6], ['2026-10-26', '2026-12-25']], 'повторы убраны, порядок по возрастанию');
  assert.match(cal.calendar_id, /^cal_[0-9a-f]{12}$/, 'идентификатор создаёт приложение');
  assert.deepEqual(ctx.journal.events().slice(n0).map((e) => e.type), ['calendar.set']);
  assert.equal(canon(ctx.get_ws().facts), facts0, 'проведённые факты не тронуты');
  assert.ok(notes().some((m) => /Календарь «Праздники» записан\./.test(m)));
  await tick();
  assert.equal(by_id('fp13-calendars-title').focused, true);
  assert.match(N(by_id('fp13-calendars').textContent), /Праздники выходные: Сб, Вс; 2 праздника Используют: правил — 0, потоков часов — 0\./);
  // правило начинает считать по новому календарю: 26 октября — праздник, значит арендный платёж уходит на 27-е
  click(find_all(rule_item(RENT), (n) => n.attrs['data-act'] === 'edit')[0]);
  choose(by_id('fp08-rule-calendar_id'), cal.calendar_id);
  assert.match(N(by_id('fp08-rule-preview').textContent), /27 октября: −900,00 €/);
  submit('fp08-rule');
  assert.equal(ctx.get_ws().rules.find((r) => r.rule_id === RENT).calendar_id, cal.calendar_id);
  assert.equal(event_date('R-RENT@2026-10-25'), '2026-10-27');
  // теперь календарь нужен правилу: удалить нельзя; «Основной» свободен
  const del = (name) => find_all(by_id('fp13-calendars'), (n) => n.attrs['data-act'] === 'cal-delete' && N(n.attrs['aria-label']).includes(name))[0];
  click(del('Праздники'));
  assert.equal(ctx.get_ws().calendars.length, 2);
  // возвращаем правило на основной календарь и удаляем свободный
  click(find_all(rule_item(RENT), (n) => n.attrs['data-act'] === 'edit')[0]);
  choose(by_id('fp08-rule-calendar_id'), 'cal-main');
  submit('fp08-rule');
  click(del('Праздники'));
  assert.deepEqual(ctx.get_ws().calendars.map((c) => c.calendar_id), ['cal-main']);
  assert.ok(notes().some((m) => /Календарь «Праздники» удалён\./.test(m)));
  assert.equal(event_date('R-RENT@2026-10-25'), '2026-10-26');
});

test('REQ-009 REQ-017 форма календаря: отказы называют код и поле, введённое не повторяется; семь выходных — E_RULE_INVALID; «Править» заполняет форму; пустой календарь допустим', async () => {
  await reset();
  const h0 = hash_now();
  const n0 = ctx.journal.length;
  submit('fp08-cal');
  assert.match(N(by_id('fp08-cal-name-err').textContent), /Не принято \(E_SCHEMA\) «Название календаря»|Не принято \(E_SCHEMA\) «Название»/);
  type_into(by_id('fp08-cal-name'), 'Тест');
  type_into(by_id('fp08-cal-holidays'), '2026-12-25 вчера');
  assert.match(N(by_id('fp13-cal-preview').textContent), /Название и даты не заполнены/);
  submit('fp08-cal');
  assert.match(N(by_id('fp08-cal-holidays-err').textContent), /Не принято \(E_BAD_DATE\) «Праздники и другие нерабочие даты»/);
  assert.ok(!N(main().textContent).includes('вчера'), 'введённое не повторяется');
  type_into(by_id('fp08-cal-holidays'), '');
  for (const d of [0, 1, 2, 3, 4, 5, 6]) check('fp08-cal-wd' + d, true);
  submit('fp08-cal');
  assert.match(status_of('fp08-cal'), /Не принято \(E_RULE_INVALID\): отмечены все дни недели, рабочих дней не останется/);
  assert.equal(ctx.get_ws().calendars.length, 1);
  assert.equal(ctx.journal.length, n0);
  assert.equal(hash_now(), h0);
  // пустой календарь: ни выходных, ни праздников
  for (const d of [0, 1, 2, 3, 4, 5, 6]) check('fp08-cal-wd' + d, false);
  assert.match(N(by_id('fp13-cal-preview').textContent), /нерабочих дней нет/);
  submit('fp08-cal');
  const cal = ctx.get_ws().calendars.at(-1);
  assert.deepEqual([cal.name, cal.weekend_dows, cal.holidays], ['Тест', [], []]);
  assert.match(N(by_id('fp13-calendars').textContent), /Тест выходные: нет; 0 праздников/);
  // «Править» заполняет форму
  click(find_all(by_id('fp13-calendars'), (n) => n.attrs['data-act'] === 'cal-edit' && N(n.attrs['aria-label']).includes('Тест'))[0]);
  assert.equal(by_id('fp08-cal-name').value, 'Тест');
  type_into(by_id('fp08-cal-holidays'), '2026-11-11');
  check('fp08-cal-wd0', true);
  submit('fp08-cal');
  assert.deepEqual(ctx.get_ws().calendars.find((c) => c.calendar_id === cal.calendar_id), { calendar_id: cal.calendar_id, name: 'Тест', weekend_dows: [0], holidays: ['2026-11-11'] });
  assert.equal(ctx.get_ws().calendars.length, 2, 'правка на месте, не копия');
  assert.ok(notes().some((m) => /Календарь «Тест» обновлён: даты будущих вхождений пересчитаны\./.test(m)));
});

test('REQ-010 карточка «Разовый платёж»: предпросмотр, запись в прогноз общим путём (журнал plan.set), список, «Править», «Удалить»; отказы с кодом без повтора; «Отменить»', async () => {
  await reset();
  const h0 = hash_now();
  const n0 = ctx.journal.length;
  assert.match(N(by_id('fp13-plans').textContent), /2026-10-23|23 октября: Налоговый платёж — −500,00 €/, 'платёж из набора виден в списке');
  type_into(by_id('fp08-plan-name'), 'Страховка');
  type_into(by_id('fp08-plan-amount'), 'abc');
  type_into(by_id('fp08-plan-date'), '2026-11-15');
  submit('fp08-plan');
  assert.match(status_of('fp08-plan'), /Не принято \(E_NOT_INTEGER\)/);
  assert.match(N(by_id('fp08-plan-amount-err').textContent), /Не принято \(E_NOT_INTEGER\) «Сумма»/);
  assert.ok(!N(main().textContent).includes('abc'), 'введённое не повторяется');
  assert.equal(ctx.get_ws().plans.length, 1);
  type_into(by_id('fp08-plan-amount'), '120');
  assert.match(N(by_id('fp13-plan-preview').textContent), /15 ноября: −120,00 €, счёт «Основной счёт»\./);
  assert.ok(!N(by_id('fp13-plan-preview').textContent).includes('раньше «сегодня»'));
  submit('fp08-plan');
  const plan = ctx.get_ws().plans.at(-1);
  assert.match(plan.plan_id, /^plan_[0-9a-f]{12}$/);
  assert.deepEqual([plan.name, plan.date, plan.amount_minor, plan.currency, plan.kind, plan.account_id], ['Страховка', '2026-11-15', -12000, 'EUR', 'expense', 'acc_main']);
  assert.deepEqual(ctx.journal.events().slice(n0).map((e) => e.type), ['plan.set']);
  assert.equal(event_date(plan.plan_id), '2026-11-15', 'платёж в прогнозе');
  assert.notEqual(hash_now(), h0);
  assert.match(N(by_id('fp13-plans').textContent), /15 ноября: Страховка — −120,00 €/);
  assert.ok(notes().some((m) => /Платёж «Страховка» записан\./.test(m)));
  await tick();
  assert.equal(by_id('fp13-plans-title').focused, true);
  const link = find_all(by_id('fp13-plans'), (n) => n.tagName === 'a')[0];
  assert.equal(link.attrs.href, '#reconcile');
  assert.equal(N(link.textContent), 'Сверке');
  // поступление
  type_into(by_id('fp08-plan-name'), 'Возврат');
  choose(by_id('fp08-plan-kind'), 'income');
  type_into(by_id('fp08-plan-amount'), '45,50');
  type_into(by_id('fp08-plan-date'), '2026-11-20');
  type_into(by_id('fp08-plan-tag'), 'возврат');
  check('fp08-plan-is_estimate', true);
  submit('fp08-plan');
  const inc = ctx.get_ws().plans.at(-1);
  assert.deepEqual([inc.name, inc.amount_minor, inc.kind, inc.tag, inc.is_estimate], ['Возврат', 4550, 'income', 'возврат', true]);
  // «Править»: форма заполнена, запись заменяется на месте
  click(find_all(by_id('fp13-plans'), (n) => n.attrs['data-act'] === 'plan-edit' && N(n.attrs['aria-label']).includes('Страховка'))[0]);
  assert.equal(by_id('fp08-plan-name').value, 'Страховка');
  assert.equal(N(by_id('fp08-plan-amount').value), '120');
  type_into(by_id('fp08-plan-amount'), '150');
  submit('fp08-plan');
  assert.equal(ctx.get_ws().plans.find((p) => p.plan_id === plan.plan_id).amount_minor, -15000);
  assert.equal(ctx.get_ws().plans.length, 3, 'правка на месте, не копия');
  assert.ok(notes().some((m) => /Платёж «Страховка» обновлён\./.test(m)));
  // «Отменить» возвращает прежнюю сумму
  const undo = nav_button('Отменить');
  assert.ok(N(undo.attrs['aria-label'] ?? undo.textContent).includes('изменение разового платежа'));
  click(undo);
  assert.equal(ctx.get_ws().plans.find((p) => p.plan_id === plan.plan_id).amount_minor, -12000);
  // удаление
  click(find_all(by_id('fp13-plans'), (n) => n.attrs['data-act'] === 'plan-delete' && N(n.attrs['aria-label']).includes('Возврат'))[0]);
  click(find_all(by_id('fp13-plans'), (n) => n.attrs['data-act'] === 'plan-delete' && N(n.attrs['aria-label']).includes('Страховка'))[0]);
  assert.deepEqual(ctx.get_ws().plans.map((p) => p.plan_id), ['P-TAX1']);
  assert.ok(notes().some((m) => /Платёж «Страховка» удалён\./.test(m)));
  assert.equal(hash_now(), h0);
});

test('REQ-010 разовый платёж в прошлом: предпросмотр объясняет, где он появится; статус «отменён» меняется в «Сверке» (set_plan_status), платёж уходит из прогноза; платёж с привязанным фактом не удаляется', async () => {
  await reset({ ...clone(G), as_of: '2026-10-12' });
  type_into(by_id('fp08-plan-name'), 'Штраф');
  type_into(by_id('fp08-plan-amount'), '30');
  type_into(by_id('fp08-plan-date'), '2026-10-08');
  assert.match(N(by_id('fp13-plan-preview').textContent), /Дата раньше «сегодня»: платёж появится в «Сверке»/);
  submit('fp08-plan');
  const plan = ctx.get_ws().plans.at(-1);
  assert.equal(plan.date, '2026-10-08');
  assert.match(N(by_id('fp13-plans').textContent), /Прошедших разовых платежей: 1; их статус — в «Сверке»\./);
  await go('#reconcile');
  assert.ok(N(main().textContent).includes('Штраф'), 'платёж виден в очереди «Сверки»');
  const cancel = find_all(main(), (n) => /^rc-cancel-/.test(n.attrs.id ?? '') && N(n.attrs['aria-label'] ?? '').includes('Штраф'))[0];
  assert.ok(cancel !== undefined, 'есть «Отменить платёж»');
  click(cancel);
  assert.equal(ctx.get_ws().plans.find((p) => p.plan_id === plan.plan_id).status, 'cancelled');
  assert.ok(!plan_events().some((e) => e.cash_event_id === plan.plan_id), 'отменённый платёж ушёл из прогноза');
  // платёж с привязанным фактом: удалить нельзя
  const linked = clone(ctx.get_ws());
  linked.facts.push({ event_id: 'tx-fine', account_id: 'acc_main', date: '2026-10-09', amount_minor: -3000, currency: 'EUR', plan_ref: plan.plan_id });
  const r = ctx.set_ws(linked, { reason: 'test_setup' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await go('#forms');
  const week = clone(ctx.get_ws());
  week.plans.push({ plan_id: 'P-NEXT', account_id: 'acc_main', name: 'Будущий', date: '2026-10-30', amount_minor: -1000, currency: 'EUR' });
  week.facts.push({ event_id: 'tx-next', account_id: 'acc_main', date: '2026-10-10', amount_minor: -1000, currency: 'EUR', plan_ref: 'P-NEXT' });
  ctx.set_ws(week, { reason: 'test_setup' });
  await go('#forms');
  click(find_all(by_id('fp13-plans'), (n) => n.attrs['data-act'] === 'plan-delete' && N(n.attrs['aria-label']).includes('Будущий'))[0]);
  assert.ok(notes().some((m) => /Не принято \(E_SCHEMA\): к этому платежу привязана проведённая запись\. Платёж можно отметить отменённым в «Сверке»\./.test(m)), notes().join(' | '));
  assert.ok(ctx.get_ws().plans.some((p) => p.plan_id === 'P-NEXT'), 'платёж на месте');
});

test('REQ-009 REQ-010 RU и EN: карточки, подписи кнопок и сообщения на английском; паритет языков; после возврата на русский тексты прежние', async () => {
  await reset();
  click(lang_button('en'));
  await go('#forms');
  assert.equal(N(by_id('fp13-calendars-title').textContent), 'Calendar of days off and holidays');
  assert.equal(N(by_id('fp13-plans-title').textContent), 'One-off payment');
  assert.equal(N(row_button(RENT, NOM, 'move').textContent), 'Move');
  assert.equal(N(row_button(RENT, NOM, 'amount').textContent), 'Other amount');
  assert.match(N(row_button(RENT, NOM, 'move').attrs['aria-label']), /^Move the occurrence of "Аренда" on October 26 to another date$/);
  const lbl = find_all(main(), (n) => n.tagName === 'label' && n.attrs.for === 'fp08-rule-workday')[0];
  assert.equal(N(lbl.textContent), 'n-th working day of the month');
  assert.ok(N(by_id('fp13-calendars').textContent).includes('The app has no ready-made holiday lists by country'));
  assert.match(N(by_id('fp08-rule-workday-hint').textContent), /"1" is the first working day/);
  // действия в английском интерфейсе
  click(row_button(RENT, NOM, 'move'));
  type_into(by_id('fp08-mv-0-0-move_date'), '2026-10-28');
  assert.match(N(by_id('fp13-ov-mv-0-0-preview').textContent), /: October 26 → October 28\./);
  type_into(by_id('fp08-mv-0-0-move_date'), '2026-13-40');
  submit('fp13-ov-mv-0-0');
  assert.match(N(by_id('fp08-mv-0-0-move_date-err').textContent), /Not accepted \(E_BAD_DATE\)/);
  type_into(by_id('fp08-mv-0-0-move_date'), '2026-10-28');
  submit('fp13-ov-mv-0-0');
  assert.ok(notes().some((m) => /is moved to October 28\. Undo restores the previous date\./.test(m)), notes().slice(-3).join(' | '));
  assert.ok(N(nav_button('Undo')?.attrs['aria-label'] ?? nav_button('Undo')?.textContent ?? '').includes('payment rule change'));
  click(nav_button('Undo'));
  type_into(by_id('fp08-cal-name'), 'Hol');
  type_into(by_id('fp08-cal-holidays'), '12/25/2026');
  assert.match(N(by_id('fp13-cal-preview').textContent), /Nearest non-working days in this calendar/);
  click(lang_button('ru'));
  await go('#forms');
  assert.equal(N(by_id('fp13-calendars-title').textContent), 'Календарь выходных и праздников');
});

test('REQ-009 форма правила не стирает списки при «открыть — сохранить»: два дня недели и два дня месяца остаются; пункт «как записано» не копится; точка расширения изолирует упавший блок и сортирует по order', async () => {
  const ws = clone(G);
  const base = ws.rules.find((r) => r.rule_id === 'R-GROC');
  ws.rules.push({ ...clone(base), rule_id: 'R-TWO', name: 'Два раза в неделю', by_weekday: [1, 3], start_date: '2026-10-05' });
  ws.rules.push({ ...clone(ws.rules.find((r) => r.rule_id === RENT)), rule_id: 'R-HALF', name: 'Дважды в месяц', by_monthday: [1, 15], start_date: '2026-01-01' });
  await reset(ws);
  const edit_btn = (id) => find_all(rule_item(id), (n) => n.attrs['data-act'] === 'edit')[0];
  const before = canon(ctx.get_ws());
  click(edit_btn('R-TWO'));
  assert.equal(by_id('fp08-rule-weekday').value, '1,3');
  assert.deepEqual(find_all(by_id('fp08-rule-weekday'), (n) => n.tagName === 'option').map((o) => N(o.textContent)).slice(-1), ['Пн, Ср']);
  click(edit_btn('R-TWO'));
  assert.equal(find_all(by_id('fp08-rule-weekday'), (n) => n.tagName === 'option' && n.attrs.value === '1,3').length, 1, 'пункт не копится при повторном открытии');
  submit('fp08-rule');
  assert.equal(canon(ctx.get_ws()), before, 'два дня недели не потеряны');
  click(edit_btn('R-HALF'));
  assert.equal(by_id('fp08-rule-monthday').value, '1, 15');
  submit('fp08-rule');
  assert.equal(canon(ctx.get_ws()), before, 'два дня месяца не потеряны');
  // блоки под формой: порядок по order, упавший блок заменяется плашкой, раздел жив
  const mk = (id) => () => { const p = document.createElement('p'); p.setAttribute('id', id); p.textContent = id; return p; };
  const offs = [RULE.register_rule_block('t_late', mk('t-late'), 900), RULE.register_rule_block('t_boom', () => { throw new Error('сбой блока'); }, 800), RULE.register_rule_block('t_early', mk('t-early'), 5)];
  await go('#forms');
  const order = find_all(by_id('fp08-sec-rules'), (n) => /^(t-early|fp13-plans|fp13-calendars|t-late)$/.test(n.attrs.id ?? '')).map((n) => n.attrs.id);
  assert.deepEqual(order, ['t-early', 'fp13-plans', 'fp13-calendars', 't-late']);
  assert.match(N(by_id('fp08-sec-rules').textContent), /Блок «rules\/t_boom» не показан из-за ошибки: остальное работает\./);
  assert.ok(by_id('fp08-rule') !== undefined, 'форма правила жива');
  for (const off of offs) off();
  await go('#forms');
  assert.equal(by_id('t-early'), undefined);
  assert.ok(by_id('fp13-calendars') !== undefined, 'блоки пакета на месте');
});

test('FP-13 безопасность и границы: ни одной строки пользователя не попадает в страницу разметкой — только через textContent; в новых модулях нет innerHTML, fetch, inline-стилей; ключи хранилища не добавлены', () => {
  for (const f of ['form_calendar.mjs', 'form_plan.mjs', 'form_rule.mjs', 'pack_fp13.mjs']) {
    const src = fs.readFileSync(path.join(DEMO, f), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'eval(', 'new Function', 'fetch(', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'setAttribute(\'style\'']) assert.ok(!src.includes(bad), `${f}: ${bad}`);
    assert.ok(!/https?:\/\//.test(src), `${f}: внешний адрес`);
  }
  assert.equal(Object.keys(I18N.ext_strings().ru).filter((k) => k.startsWith('calendars.')).length > 40, true);
  assert.deepEqual(BR.BUCKETS.filter((b) => ['calendars', 'plans', 'overrides'].includes(b.ws_key)).map((b) => b.type), ['calendar.set', 'plan.set', 'override.set']);
  const off = RULE.register_rule_block('t1', () => null, 1);
  assert.equal(typeof off, 'function', 'точка расширения возвращает снятие блока');
  off();
});
