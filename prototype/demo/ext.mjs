// ext.mjs — реестр расширений демо (FP-01): экраны, слоты, хуки, строки, стили и общий путь записи «ws изменился → пересчёт → показ».
// app.mjs читает реестр, а не знает пакеты поимённо; пакеты (demo/pack_fpNN.mjs) регистрируют своё одной функцией `register(ext)`
// и не импортируют app.mjs (нет циклов). Документация для авторов пакетов — demo/README_ext.md.
//
// Устойчивость: реестр терпимый. Падение одного пакета, экрана, блока или хука (исключение) перехватывается, показывается сообщением
// `notify` и записью в `diagnostics()`; остальное приложение продолжает работать. Пакет, который упал в `register`, откатывается целиком
// (его экраны, блоки и хуки снимаются). Отсутствие файла пакета — норма и сообщения не даёт.
// Защита от внедрения: узлы строит только `dom.mjs` (текст — через textContent), ни один хук не получает право на inline-код; `ensure_css`
// принимает только `css/<имя>.css` рядом со страницей (CSP `style-src 'self'`).
// Модуль можно импортировать в Node: DOM и сеть трогаются только при вызове функций.

import { h } from './dom.mjs';
import { t as i18n_t, DEFAULT_LANG, register_strings } from './i18n.mjs';
import { make_id_gen, system_ports } from './ids.mjs';
import { apply_edit, register_edit, register_validator } from './ws_edit.mjs';
import { create_journal, ports_from_gen } from './journal_log.mjs';
import { ws_to_events, sync_journal } from './ws_bridge.mjs';
import { LOADERS } from './ext_manifest.mjs';
import { workspace_format_info, KNOWN_FORMAT_VERSION } from '../engine/io_readonly.mjs';

/**
 * Слоты, в которые пакеты добавляют блоки: `register_slot_item(slot, {id, order, render(ctx) → Node})`.
 * Слот `waves.card` (S1.5) вызывается для КАЖДОЙ карточки волны и получает вторым аргументом описание карточки:
 * `render(ctx, card)`, `card = {wave, mode, index}` (волна движка, режим страницы `plan|worse`, номер карточки в списке с нуля).
 * Слот `banner.warning` (FP-15) вызывается для КАЖДОГО предупреждения движка в шапке и получает вторым аргументом `{warning}` (объект предупреждения, например
 * `{code: 'W_RESERVE_RESIDUAL', reserve_id}`): блок кладёт в конец плашки действие (кнопку) или возвращает `null` для чужих предупреждений.
 * Слоты FP-28: `feed.head` (экран «Лента», под заголовком; `render(ctx, {shown, total, limit})` — сколько последних фактов показано из скольки), `feed.row` (в ячейке названия КАЖДОЙ строки ленты;
 * `render(ctx, row)`, `row = {layer: 'past'|'future', index, id, name, date, amount_minor, mode, transfer}` — действия строки: «Почему», «Исправить»), `buy.form` («Купить», в карточке полей;
 * `render(ctx, {rerun})` — переключатель «разбить на N платежей», `rerun()` пересчитывает ответ) и `buy.result` («Купить», в ответе перед формулировкой; `render(ctx, {date, amount_minor, multi_part})`
 * на КАЖДЫЙ пересчёт ответа). У остальных слотов `render` получает один аргумент — `ctx`.
 */
export const SLOTS = Object.freeze(['overview.cards', 'reserves.sections', 'data.sections', 'waves.actions', 'nav.actions', 'assistant.extras', 'banner.actions', 'scenarios.after', 'waves.card', 'banner.warning', 'feed.head', 'feed.row', 'buy.form', 'buy.result']);

/**
 * Хуки: `scenario_ops` (новые виды сценариев → операции), `show_why` (блоки в диалог «Почему»), `boot` (после загрузки набора данных),
 * `fmt` (форматтер чисел и дат: `(ctx, lang, cur, as_of_iso, number_format) → форматтер | undefined`; первый ответ не `undefined` побеждает, REQ-112),
 * `assistant` (FP-20, ассистент A0: `(ctx, action, ...args)`; `chip` → узел чипа происхождения ответа для `(result, ref, open_numbers)`, где `open_numbers()` открывает таблицу чисел расчёта, `ports` → порты вопроса: журнал страницы,
 * `call_log`, `last_call` и `record(result, args)`; для других действий хук отвечает `undefined`),
 * `dataset_label` (FP-48: подпись источника данных в переключателе «Набор данных»; `(ctx, dataset_id) → {value, text, builtin?} | undefined`, `dataset_id` — выбранный встроенный набор или `custom`;
 * ответ — пункт, который страница ставит выбранным вместо встроенного, когда данные уже не встроенный набор «как есть» (с устройства, из файла, изменённый); `undefined` — прежние подписи;
 * `builtin` (FP-49) — идентификатор встроенного набора, когда пункт называет его правленую копию: по нему кнопка «Вернуть выбранный набор» остаётся включённой).
 */
export const HOOKS = Object.freeze(['scenario_ops', 'show_why', 'boot', 'fmt', 'assistant', 'dataset_label']);

/** Экраны приложения; их идентификаторы пакетам недоступны. */
export const CORE_VIEWS = Object.freeze(['overview', 'buy', 'waves', 'reserves', 'scenarios', 'feed', 'assistant', 'data']);

const VIEW_ID_RE = /^[a-z][a-z0-9_]{1,24}$/;
const KEY_RE = /^[a-z][a-z0-9]*\.[a-z0-9_]+$/;
const CSS_RE = /^css\/[a-z0-9_-]+\.css$/;
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Ошибка регистрации (пакет ошибся в описании экрана, слота, хука). */
export class ExtError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExtError';
  }
}

function check_def(def, what) {
  if (!is_obj(def)) throw new ExtError(what + ': нужен объект описания');
  if (typeof def.id !== 'string' || !VIEW_ID_RE.test(def.id)) throw new ExtError(what + ': id — [a-z][a-z0-9_]{1,24}');
  if (typeof def.render !== 'function') throw new ExtError(what + ': нужна функция render(ctx)');
  if (def.order !== undefined && !Number.isFinite(def.order)) throw new ExtError(what + ': order — число');
}

/** Модуль пакета не найден (это норма), а не упал при загрузке. */
function is_absent(e, name) {
  const msg = String(e?.message ?? '');
  if (e?.code === 'ERR_MODULE_NOT_FOUND') {
    const m = /Cannot find module '([^']+)'/.exec(msg);
    return m === null ? false : m[1].replace(/\\/g, '/').endsWith('/' + name + '.mjs');
  }
  return e instanceof TypeError && /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(msg);
}

/**
 * Создать реестр. В приложении используется один экземпляр — `ext`; тесты создают свои.
 * @param {{ports?: {now_ms: () => number, random: () => number}, loaders?: Object<string, () => Promise<any>>}} [opts]
 */
export function create_ext(opts = {}) {
  const views = new Map();
  const slots = new Map(SLOTS.map((s) => [s, new Map()]));
  const hooks = new Map(HOOKS.map((n) => [n, []]));
  const subs = new Set();
  const diag = [];
  const css = new Set();
  let host = null;
  let journal = null;
  // Режим «только чтение» (FP-17, REQ-016): набор данных открыт из файла новее известного формата (или с записями новее известных) — прогноз виден,
  // а любая запись (ctx.edit, ctx.set_ws) отклоняется до того, как попадёт на страницу или в журнал. `null` — обычный режим.
  let read_only = null;
  let seq = 0;
  let ports = opts.ports ?? null;
  let gen = null;

  const id_gen = () => { gen ??= make_id_gen(ports ??= system_ports()); return gen; };
  const lang = () => (host !== null && typeof host.lang === 'function' ? host.lang() : DEFAULT_LANG);
  const tr = (key, params) => i18n_t(lang(), key, params);
  const record = (entry) => { diag.push(entry); if (diag.length > 200) diag.shift(); };

  /** Сообщение пользователю (если страница подключена) и запись в диагностику. */
  const notify = (msg, kind = 'info') => {
    record({ status: 'notify', kind, message: String(msg).slice(0, 300) });
    try { host?.notify?.(msg, kind); } catch { /* сообщение не должно ломать вызывающего */ }
  };

  /** Выполнить `fn`; исключение — в диагностику и `notify`, результат — `fallback`. */
  const safe = (label, fn, fallback) => {
    try { return fn(); } catch (e) {
      record({ status: 'failed', label, message: String(e?.message ?? e).slice(0, 300) });
      notify(tr('ext.block_failed', { id: label }), 'error');
      return fallback;
    }
  };

  /** Описание режима «только чтение» в неизменяемом виде: только числа, короткие строки и признак (текст файла сюда не попадает). */
  const freeze_ro = (x) => Object.freeze({
    newer_format: x.newer_format === true,
    format: typeof x.format === 'string' ? x.format.slice(0, 40) : '',
    format_version: Number.isSafeInteger(x.format_version) ? x.format_version : null,
    known_version: Number.isSafeInteger(x.known_version) ? x.known_version : KNOWN_FORMAT_VERSION,
    skipped: Number.isSafeInteger(x.skipped) && x.skipped >= 0 ? x.skipped : 0,
    source: typeof x.source === 'string' ? x.source.slice(0, 20) : 'file',
  });
  /** Набор данных с полем `format` новее известного (рабочая область G-001 несёт его так же, как журнал) открывается только для чтения. */
  const read_only_of_ws = (ws) => {
    const fi = workspace_format_info(ws);
    return fi !== null && fi.newer ? freeze_ro({ newer_format: true, format: fi.format, format_version: fi.version, source: 'workspace' }) : null;
  };
  const err_of = (e) => (e !== null && typeof e === 'object' && typeof e.code === 'string' ? { code: e.code, ctx: e.ctx ?? null } : { code: 'E_SCHEMA', ctx: { reason: 'host_error' } });
  const refuse = (reason) => ({ ok: false, error: { code: 'E_SCHEMA', ctx: { reason } } });

  // ── регистрация ───────────────────────────────────────────────────────────────────────────────────────────────────

  const register_view = (def) => {
    check_def(def, 'register_view');
    if (CORE_VIEWS.includes(def.id) || views.has(def.id)) throw new ExtError('register_view: идентификатор занят: ' + def.id);
    if (typeof def.title_key !== 'string' || !KEY_RE.test(def.title_key)) throw new ExtError('register_view: title_key — «пакет.ключ»');
    views.set(def.id, { id: def.id, title_key: def.title_key, order: def.order ?? 500, render: def.render, seq: seq++ });
    return def.id;
  };

  const register_slot_item = (slot, def) => {
    if (!SLOTS.includes(slot)) throw new ExtError('register_slot_item: неизвестный слот ' + String(slot));
    check_def(def, 'register_slot_item');
    const bucket = slots.get(slot);
    if (bucket.has(def.id)) throw new ExtError('register_slot_item: идентификатор занят в слоте ' + slot + ': ' + def.id);
    bucket.set(def.id, { id: def.id, order: def.order ?? 500, render: def.render, seq: seq++ });
    return def.id;
  };

  const register_hook = (name, fn) => {
    if (!HOOKS.includes(name)) throw new ExtError('register_hook: неизвестный хук ' + String(name));
    if (typeof fn !== 'function') throw new ExtError('register_hook: нужна функция');
    const rec = { fn, seq: seq++ };
    hooks.get(name).push(rec);
    return () => { const a = hooks.get(name); const i = a.indexOf(rec); if (i >= 0) a.splice(i, 1); };
  };

  const register_i18n = (pack, catalog) => register_strings(pack, catalog);

  /** Подключить `css/<имя>.css` (относительно страницы). В Node (нет `document`) только запоминает адрес. */
  const ensure_css = (href) => {
    if (typeof href !== 'string' || !CSS_RE.test(href)) throw new ExtError('ensure_css: допустим только css/<имя>.css');
    if (css.has(href)) return false;
    css.add(href);
    if (typeof document === 'undefined' || document.head === null || document.head === undefined) return true;
    if (!Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).some((l) => l.getAttribute('href') === href)) {
      document.head.append(h('link', { rel: 'stylesheet', href }));
    }
    return true;
  };

  // ── новый идентификатор и журнал ──────────────────────────────────────────────────────────────────────────────────

  const new_id = (prefix) => id_gen().entity(prefix);

  /** Журнал текущей рабочей области (создаётся при первом обращении из `ws_to_events`; дальше следует за правками). */
  const get_journal = () => {
    const ws = host?.get_ws?.() ?? null;
    if (journal === null && ws !== null) {
      journal = safe('journal', () => create_journal({ events: ws_to_events(ws), ports: ports_from_gen(id_gen()) }), null);
    }
    return journal;
  };

  const emit = (info) => {
    for (const fn of [...subs]) safe('subscriber', () => fn(info), undefined);
  };

  // ── общий путь записи ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Отказ в записи в режиме «только чтение»: понятный текст пользователю, код `E_SCHEMA` (`reason: 'read_only'`) вызывающему, данные не тронуты. */
  const deny_read_only = () => {
    notify(tr('ro.refused'), 'error');
    return refuse('read_only');
  };

  /**
   * Заменить рабочую область: страница пересчитывает модель (при отказе откатывается к прежней), журнал дописывается разностью,
   * подписчики уведомляются, страница перерисовывается.
   * @returns {{ok: true, ws: object} | {ok: false, error: {code: string, ctx: object|null}}}
   */
  const set_ws = (ws, o = {}) => {
    if (host === null) return refuse('no_host');
    // Исключение — `restore` («Продолжить с сохранённого», «Восстановить»): это не правка, а замена открытого набора сохранёнными данными, она режим снимает.
    if (read_only !== null && o.reason !== 'restore') return deny_read_only();
    if (!is_obj(ws)) return refuse('workspace_not_object');
    const before = host.get_ws();
    let r;
    try { r = host.set_ws(ws, o); } catch (e) { return { ok: false, error: err_of(e) }; }
    if (r?.ok !== true) return { ok: false, error: err_of(r?.error) };
    if (o.reason === 'restore') read_only = read_only_of_ws(ws);
    if (journal !== null && before !== null) {
      try { sync_journal(journal, before, ws); } catch (e) {
        journal = null; // разошёлся с рабочей областью: пересоберётся из неё при следующем обращении
        record({ status: 'failed', label: 'journal_sync', message: String(e?.message ?? e).slice(0, 300) });
      }
    }
    // Подписчики получают рабочую область «до» и «после» и описание действия: единая стопка «Отменить» (S1.3) строит единицу по разности.
    // Старые подписчики читают только `reason` и `ws`; лишние поля им не мешают. `undo` — признак «стопка уже записала это действие» (`'recorded'`).
    // `origin` (FP-48) — откуда пришли данные при `restore`: `{kind: 'file', name}` для «Восстановить из файла», иначе `null` (с устройства); название файла — только короткая строка.
    emit({ reason: o.reason ?? 'edit', ws, before, meta: o.meta ?? null, undo: o.undo ?? null, origin: is_obj(o.origin) && o.origin.kind === 'file' ? Object.freeze({ kind: 'file', name: typeof o.origin.name === 'string' ? o.origin.name.slice(0, 80) : '' }) : null });
    host.render();
    return { ok: true, ws };
  };

  /** Применить правку из словаря `ws_edit` к текущей рабочей области через общий путь. */
  const edit_ws = (edit, o = {}) => {
    const ws = host?.get_ws?.() ?? null;
    if (ws === null) return refuse('no_workspace');
    if (read_only !== null) return deny_read_only(); // раньше проверки правки: иначе пользователь увидел бы технический отказ `newer_format`
    const r = apply_edit(ws, edit, { new_id });
    if (!r.ok) { notify(tr('ext.edit_rejected', { code: r.error.code }), 'error'); return r; }
    const s = set_ws(r.ws, { reason: o.reason ?? edit.type, meta: o.meta, undo: o.undo });
    if (!s.ok) notify(tr('ext.edit_rejected', { code: s.error.code }), 'error');
    return s;
  };

  const ctx = Object.freeze({
    get_ws: () => host?.get_ws?.() ?? null,
    set_ws,
    /** Режим «только чтение» (FP-17): `null` или `{newer_format, format, format_version, known_version, skipped, source}` (неизменяемый объект). */
    read_only: () => read_only,
    edit: edit_ws,
    get_model: () => host?.get_model?.() ?? null,
    subscribe: (fn) => { if (typeof fn !== 'function') throw new ExtError('subscribe: нужна функция'); subs.add(fn); return () => subs.delete(fn); },
    tr,
    fmt: () => host?.fmt?.() ?? null,
    lang,
    mode: () => host?.mode?.() ?? 'worse',
    notify,
    new_id,
    /** «Спросить ассистента» (FP-28): открыть экран «Ассистент» с заготовкой вопроса в поле ввода (вопрос сам не отправляется); `false`, если страница не умеет. */
    ask: (question) => { if (typeof question !== 'string' || typeof host?.ask !== 'function') return false; host.ask(question); return true; },
    /** Перерисовать страницу без записи и без рассылки подписчикам (FP-05: состояние хранилища изменилось). */
    refresh: () => { try { host?.render?.(); } catch (e) { record({ status: 'failed', label: 'refresh', message: String(e?.message ?? e).slice(0, 300) }); } },
    /** Подменить набор данных целиком (восстановление из копии): журнал пересобирается, подписчики получают `adopt` с `source`. */
    adopt: (ws, o = {}) => {
      if (host === null || typeof host.adopt !== 'function') return refuse('no_host');
      if (!is_obj(ws)) return refuse('workspace_not_object');
      let r;
      try { r = host.adopt(ws, o); } catch (e) { return { ok: false, error: err_of(e) }; }
      return r?.ok === true ? { ok: true, ws } : { ok: false, error: err_of(r?.error) };
    },
    get journal() { return get_journal(); },
  });

  // ── чтение реестра страницей ──────────────────────────────────────────────────────────────────────────────────────

  const api = {
    // для пакетов
    register_view, register_slot_item, register_hook, register_i18n, ensure_css, register_edit, register_validator, ctx,

    /** Подключить страницу: `{get_ws, get_model, lang, mode, fmt, set_ws(ws, o) → {ok, error?}, adopt?(ws, o) → {ok, error?}, render(), notify(msg, kind)}`. */
    bind_host(h_) { host = h_; },

    /** Пункты навигации: экраны приложения (`core`, место (i+1)·10) и экраны пакетов (по `order`). */
    nav_items(core = CORE_VIEWS) {
      const items = core.map((id, i) => ({ id, title_key: 'nav.' + id, order: (i + 1) * 10, core: true, seq: -1000 + i }));
      for (const v of views.values()) items.push({ id: v.id, title_key: v.title_key, order: v.order, core: false, seq: v.seq });
      return items.sort((a, b) => (a.order - b.order) || (a.seq - b.seq)).map(({ id, title_key, core: c }) => ({ id, title_key, core: c }));
    },
    has_view: (id) => views.has(id),

    /** Нарисовать экран пакета; ошибка — плашка вместо экрана и сообщение, остальные экраны живы. */
    render_view(id, c = ctx) {
      const def = views.get(id);
      const fail_node = () => h('p', { class: 'banner short', role: 'alert', text: tr('ext.view_failed', { id }) });
      if (def === undefined) return fail_node();
      return safe('view:' + id, () => {
        const node = def.render(c);
        if (node === null || typeof node !== 'object' || node.nodeType !== 1) throw new TypeError('render должен вернуть элемент');
        return node;
      }, fail_node());
    },

    /**
     * Узлы слота по порядку (`order`, затем порядок регистрации); упавший блок пропускается.
     * Дополнительные аргументы `extra` передаются в `render` после `ctx` (слот `waves.card`: описание карточки); без них `render(ctx)` — как прежде.
     */
    slot_nodes(slot, c = ctx, ...extra) {
      const bucket = slots.get(slot);
      if (bucket === undefined) return [];
      const out = [];
      for (const it of [...bucket.values()].sort((a, b) => (a.order - b.order) || (a.seq - b.seq))) {
        const r = safe('slot:' + slot + '/' + it.id, () => it.render(c, ...extra), null);
        for (const n of [r].flat(Infinity)) if (n !== null && n !== undefined && typeof n === 'object' && n.nodeType === 1) out.push(n);
      }
      return out;
    },

    /** Хуки по порядку регистрации: первый ответ, не равный `undefined`. Функция получает `(ctx, ...args)`. */
    first(name, ...args) {
      for (const { fn } of [...(hooks.get(name) ?? [])]) {
        const r = safe('hook:' + name, () => fn(ctx, ...args), undefined);
        if (r !== undefined) return r;
      }
      return undefined;
    },

    /** Все ответы хуков, которые узлы (или массивы узлов), в порядке регистрации. */
    collect(name, ...args) {
      const out = [];
      for (const { fn } of [...(hooks.get(name) ?? [])]) {
        const r = safe('hook:' + name, () => fn(ctx, ...args), null);
        for (const n of [r].flat(Infinity)) if (n !== null && n !== undefined && typeof n === 'object' && n.nodeType === 1) out.push(n);
      }
      return out;
    },

    /** Вызвать хуки по очереди (асинхронные ждутся); ошибки изолированы. */
    async run(name, ...args) {
      for (const { fn } of [...(hooks.get(name) ?? [])]) {
        try { await fn(ctx, ...args); } catch (e) {
          record({ status: 'failed', label: 'hook:' + name, message: String(e?.message ?? e).slice(0, 300) });
          notify(tr('ext.block_failed', { id: 'hook:' + name }), 'error');
        }
      }
    },

    /** Рабочая область заменена целиком (набор данных, файл): журнал пересоберётся, подписчики узнают. */
    reset(ws, o = {}) {
      journal = null;
      read_only = is_obj(o.read_only) ? freeze_ro({ ...o.read_only, source: o.read_only.source ?? o.source }) : read_only_of_ws(ws); // набор новее известного формата — только для чтения
      emit({ reason: 'adopt', ws, source: o.source ?? 'dataset', dataset_id: typeof o.dataset_id === 'string' ? o.dataset_id : null, file_name: typeof o.file_name === 'string' ? o.file_name.slice(0, 80) : null }); // dataset_id: встроенный набор или `custom` (FP-22); file_name — имя открытого файла (FP-48)
    },

    /** Загрузить пакеты из манифеста: отсутствие файла — норма, падение пакета — сообщение и откат его регистраций. */
    async load_packs(custom) {
      const loaders = custom ?? opts.loaders ?? LOADERS;
      for (const name of Object.keys(loaders)) {
        let mod;
        try { mod = await loaders[name](); } catch (e) {
          if (is_absent(e, name)) { record({ status: 'absent', pack: name }); continue; }
          record({ status: 'failed', pack: name, message: String(e?.message ?? e).slice(0, 300) });
          notify(tr('ext.pack_failed', { pack: name }), 'error');
          continue;
        }
        const mine = { views: [], items: [], unhooks: [] };
        const scoped = {
          pack: name,
          register_i18n,
          ensure_css,
          register_edit,
          register_validator,
          ctx,
          diagnostics: api.diagnostics,
          register_view: (d) => { const id = register_view(d); mine.views.push(id); return id; },
          register_slot_item: (s, d) => { const id = register_slot_item(s, d); mine.items.push([s, id]); return id; },
          register_hook: (n, f) => { const off = register_hook(n, f); mine.unhooks.push(off); return off; },
        };
        try {
          if (typeof mod?.register !== 'function') throw new TypeError('в пакете нет register(ext)');
          await mod.register(scoped);
          record({ status: 'ok', pack: name });
        } catch (e) {
          for (const id of mine.views) views.delete(id);
          for (const [s, id] of mine.items) slots.get(s).delete(id);
          for (const off of mine.unhooks) off();
          record({ status: 'failed', pack: name, message: String(e?.message ?? e).slice(0, 300) });
          notify(tr('ext.pack_failed', { pack: name }), 'error');
        }
      }
    },

    /** Журнал загрузки и сбоев: `[{status: 'ok'|'absent'|'failed'|'notify', pack?, label?, message?}]`. */
    diagnostics: () => diag.slice(),
  };
  return api;
}

/** Реестр приложения. */
export const ext = create_ext();
