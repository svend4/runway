// data_view.mjs — узлы экрана «Данные» для пакета FP-05: плашка «продолжить с сохранённого», баннер «сделайте файл-копию», хранение и файлы,
// отчёт «где что лежит», удаление всех данных. Тонкий слой DOM поверх чистых моделей (`data_actions.mjs`, `data_runtime.mjs`, `backup.mjs`, `rights.mjs`).
// Защита от внедрения: только `dom.mjs` (textContent, без inline-стилей и обработчиков); файл читается как текст и разбирается `inspect_import` (недоверенные данные).
// Расчёт по введённым данным и правилам, не консультация.

import { h, table, open_dialog, close_dialog } from './dom.mjs';
import {
  export_csv_file, export_hledger_file, format_losses, inspect_import, restore_preview, counts_of_ws, file_name, FORMAT_LOSSES,
} from './data_actions.mjs';
import { MAX_IMPORT_BYTES } from '../engine/io.mjs';
import { FILE_BANNER_REASONS } from './backup.mjs';
import { FILE_CODES } from './backup_file.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { clock_ports } from './ids.mjs';

const short = (hash) => String(hash).slice(0, 8);

/**
 * Хранитель фокуса на среду выполнения (FP-19): действия автозаписи убирают нажатую кнопку (баннер исчезает, блок перерисовывается), а хранилище (FP-05) после
 * каждой записи просит ещё одну перерисовку страницы позже — без возврата фокус уходил бы на body (WCAG 2.4.3). `apply()` вызывается в конце каждой отрисовки.
 */
const KEEPERS = new WeakMap();
function keeper_of(rt) {
  let k = KEEPERS.get(rt);
  if (k === undefined) { k = create_focus_keeper(() => clock_ports().now_ms()); KEEPERS.set(rt, k); }
  return k;
}

// ── автозапись в файл-копию (FP-19, REQ-097): тексты причин, сообщения и обработчики ───────────────────────────────────

/** Причина неудачи словами (код → строка `backupfile.reason_<код>`); неизвестный код — «причина не определена». */
function reason_text(ctx, code) {
  return ctx.tr('backupfile.reason_' + (FILE_CODES.includes(code) ? code : 'other'));
}

/**
 * Сообщение после выбора файла: [текст, вид]. «Только чтение» называет причину текстом `ro.refused`, а не кодом. Запись не начата (`not_ready`) — по режиму хранения:
 * в `found` запись начнётся после «Продолжить с сохранённого» / «Начать с текущего набора», в прочих режимах (приостановлено, ошибка хранилища, данные удалены)
 * таких кнопок нет — текст про них не обещает.
 */
function pick_notice(ctx, r) {
  if (r.ok) {
    const w = r.write;
    if (w?.ok === true) return [ctx.tr('backupfile.picked_ok', { name: r.name, n: w.count, hash: short(w.hash) }), 'info'];
    if (w?.code === 'not_ready') return [ctx.tr(w.mode === 'found' ? 'backupfile.picked_wait' : 'backupfile.picked_idle', { name: r.name }), 'info'];
    return [ctx.tr('backupfile.picked_write_failed', { name: r.name, reason: reason_text(ctx, w?.code) }), 'error'];
  }
  if (r.reason === 'cancelled') return [ctx.tr('backupfile.cancelled'), 'info'];
  if (r.reason === 'read_only') return [ctx.tr('ro.refused'), 'error'];
  return [ctx.tr('backupfile.pick_failed', { reason: reason_text(ctx, r.reason) }), 'error'];
}

/** Сообщение после записи в файл: [текст, вид]. Запись не начата (`not_ready`) — по режиму хранения, как в `pick_notice`. */
function write_notice(ctx, w) {
  if (w.ok === true) return [ctx.tr('backupfile.written_ok', { n: w.count, hash: short(w.hash) }), 'info'];
  if (w.code === 'read_only') return [ctx.tr('ro.refused'), 'error'];
  if (w.code === 'not_ready') return [ctx.tr(w.mode === 'found' ? 'backupfile.write_wait' : 'backupfile.write_idle'), 'info'];
  return [ctx.tr('backupfile.write_failed', { reason: reason_text(ctx, w.code) }), 'error'];
}

const say = (ctx, [text, kind]) => ctx.notify(text, kind);
const say_failed = (ctx) => ctx.notify(ctx.tr('backupfile.write_failed', { reason: reason_text(ctx, 'other') }), 'error');

/** Файл-копия выбран (фаза `ready | permission | failed`): имя файла или `null`. Для предупреждений в окнах подтверждения. */
function chosen_file_name(rt) {
  const f = rt.status().file;
  return f !== null && f !== undefined && (f.phase === 'ready' || f.phase === 'permission' || f.phase === 'failed') ? f.name : null;
}

/**
 * Ответ асинхронной работы (окно выбора файла, вопрос разрешения, запись) пришёл: окно запроса фокуса (3 с) могло истечь, пока пользователь выбирал файл,
 * поэтому запрос повторяется и страница перерисовывается через общий `ctx.refresh` (а не через замыкание отсоединённого узла). `id` — куда вернуть фокус:
 * на нажатую кнопку, а если она после действия исчезла (баннер, «Разрешить запись», «Не использовать файл»), — на соседнюю кнопку блока.
 */
function settled(ctx, rt, id) {
  keeper_of(rt).request(id);
  try { ctx.refresh?.(); } catch { /* перерисуется при следующем действии */ }
}

/** «Выбрать файл-копию»: вызов браузера — первое действие обработчика (выбор файла допускается только по жесту пользователя). */
function file_pick_click(ctx, rt) {
  keeper_of(rt).request('fp19-pick');
  return rt.file_pick().then((r) => { say(ctx, pick_notice(ctx, r)); settled(ctx, rt, 'fp19-pick'); }, () => { say_failed(ctx); settled(ctx, rt, 'fp19-pick'); });
}

/** «Записать в файл сейчас» в блоке хранения (`fp19-write`) и в баннере (`fp19-banner-write`): после удачной записи баннер исчезает, фокус — на кнопку блока. */
function file_write_click(ctx, rt, origin) {
  keeper_of(rt).request(origin);
  return rt.file_write_now().then((w) => { say(ctx, write_notice(ctx, w)); settled(ctx, rt, w.ok === true ? 'fp19-write' : origin); }, () => { say_failed(ctx); settled(ctx, rt, origin); });
}

/**
 * «Разрешить запись» в блоке хранения (`fp19-allow`) и в баннере (`fp19-banner-allow`): вопрос браузеру — первое действие обработчика. Текст по итогу: «возобновлена»
 * только если запись действительно состоялась; запись ещё не идёт (режим хранения, приостановка) — разрешение получено, но об автозаписи ничего не обещано.
 */
function file_allow_click(ctx, rt, origin) {
  keeper_of(rt).request(origin);
  return rt.file_permission().then((r) => {
    if (!r.ok) ctx.notify(ctx.tr('backupfile.allowed_refused'), 'error');
    else {
      const w = r.write ?? { ok: false, code: 'write' };
      if (w.ok === true) ctx.notify(ctx.tr('backupfile.allowed_ok'), 'info');
      else if (w.code === 'not_ready') ctx.notify(ctx.tr(w.mode === 'found' ? 'backupfile.allowed_wait' : 'backupfile.allowed_idle'), 'info');
      else if (w.code === 'held') ctx.notify(ctx.tr('backupfile.held', { name: rt.status().file?.name ?? '' }), 'info');
      else say(ctx, write_notice(ctx, w));
    }
    settled(ctx, rt, r.ok ? 'fp19-write' : origin);
  }, () => { say_failed(ctx); settled(ctx, rt, origin); });
}

function file_forget_click(ctx, rt) {
  keeper_of(rt).request('fp19-forget');
  return rt.file_forget().then(() => { ctx.notify(ctx.tr('backupfile.forgotten'), 'info'); settled(ctx, rt, 'fp19-pick'); }, () => { say_failed(ctx); settled(ctx, rt, 'fp19-forget'); });
}

/** Ключ строки причины баннера: причины автозаписи — в каталоге `backupfile`, прочие — в `data`. */
const banner_key = (r) => (FILE_BANNER_REASONS.includes(r) ? 'backupfile.banner_' + r : 'data.banner_' + r);

/** Скачать текст как файл (Blob + временная ссылка; адрес освобождается через 2 с). */
export function download_text(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Режим «только чтение» (FP-17): сведения для экрана или `null`. Источник — реестр расширений (`ctx.read_only()`); если его нет (заглушки), — признак среды хранения.
 * @returns {{newer_format?: boolean, format?: string, format_version?: number, known_version?: number, skipped?: number}|null}
 */
export function read_only_info(ctx, rt) {
  const d = typeof ctx.read_only === 'function' ? ctx.read_only() : null;
  if (d !== null && d !== undefined) return d;
  return rt.status().read_only === true ? {} : null;
}

/** Плашка «в хранилище есть журнал»: продолжить с сохранённого или начать с текущего набора (стирание — после подтверждения; в режиме «только чтение» — без стирания). */
export function render_continue_card(ctx, rt) {
  const st = rt.status();
  if (st.mode !== 'found' && !(st.mode === 'paused' && st.saved > 0)) return null;
  const ro = read_only_info(ctx, rt) !== null;
  const ask_replace = () => open_dialog(ctx.tr('data.replace_title'), ctx.tr('data.close'),
    h('p', { text: ctx.tr('data.replace_warn', { n: st.saved }) }),
    // выбран файл-копия: в нём лежит копия прежнего журнала, автозапись её не заменит без решения пользователя
    chosen_file_name(rt) === null ? null : h('p', { class: 'banner short', role: 'note', text: ctx.tr('backupfile.replace_file_warn', { name: chosen_file_name(rt) }) }),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', text: ctx.tr('data.replace_confirm'), onclick: async () => {
      close_dialog();
      const r = await rt.replace_saved();
      ctx.notify(r.ok ? ctx.tr('data.replaced_ok') : ctx.tr('data.action_failed', { code: r.error }), r.ok ? 'info' : 'error');
    } })));
  return h('section', { class: 'card data-card', role: 'region', 'aria-label': ctx.tr('data.continue_title') },
    h('h3', { text: ctx.tr('data.continue_title') }),
    h('p', { text: ctx.tr('data.continue_lead', { n: st.saved }) }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', text: ctx.tr('data.continue_yes'), onclick: async () => {
        const r = await rt.continue_saved();
        ctx.notify(r.ok ? ctx.tr('data.continued_ok', { n: r.count }) : ctx.tr('data.action_failed', { code: r.error }), r.ok ? 'info' : 'error');
      } }),
      ro ? null : h('button', { type: 'button', class: 'btn', text: ctx.tr('data.continue_no'), onclick: ask_replace })),
    // пока открыт просмотр, «текущего набора» для записи нет: сохранённое можно только продолжить, стереть ради просмотра нельзя
    h('p', { class: 'muted', text: ctx.tr(ro ? 'data.readonly_no_replace' : 'data.continue_hint') }));
}

/** Баннер «сделайте файл-копию»: причины — из `backup_banner` (пора по числам, нет закрепления, не установлено, данные только во вкладке). */
export function render_backup_banner(ctx, rt) {
  const st = rt.status();
  keeper_of(rt).apply(); // возврат фокуса после действий автозаписи: баннер мог исчезнуть вместе с нажатой кнопкой
  if (!st.banner.show || read_only_info(ctx, rt) !== null) return null; // из просмотра копию не сделать: напоминать о ней нечем
  const reason = reason_text(ctx, st.file?.last_error);
  const items = st.banner.reasons.map((r) => h('li', { text: ctx.tr(banner_key(r), { n: st.events_since, days: st.days_since, reason }) }));
  return h('section', { class: 'card data-card banner', role: 'region', 'aria-label': ctx.tr('data.banner_title') },
    h('h3', { text: ctx.tr('data.banner_title') }),
    h('ul', null, items),
    // ручная выгрузка остаётся всегда; при сбое автозаписи рядом — повтор записи в файл, при отозванном разрешении — вопрос браузеру
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', text: ctx.tr('data.save_journal'), onclick: () => save_journal(ctx, rt) }),
      st.banner.reasons.includes('file_permission') ? h('button', { type: 'button', class: 'btn', id: 'fp19-banner-allow', text: ctx.tr('backupfile.allow'), onclick: () => file_allow_click(ctx, rt, 'fp19-banner-allow') }) : null,
      st.banner.reasons.includes('file_failed') ? h('button', { type: 'button', class: 'btn', id: 'fp19-banner-write', text: ctx.tr('backupfile.write_now'), onclick: () => file_write_click(ctx, rt, 'fp19-banner-write') }) : null));
}

async function save_journal(ctx, rt) {
  try {
    const copy = await rt.export_copy();
    download_text(file_name('journal', copy.day), copy.text, 'application/json');
    ctx.notify(ctx.tr('data.saved_journal', { n: copy.count, hash: short(copy.state_hash) }), 'info');
  } catch (e) {
    if (e?.code === 'read_only') ctx.notify(ctx.tr('data.readonly_no_copy'), 'error');
    else ctx.notify(ctx.tr('data.action_failed', { code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA' }), 'error');
  }
}

function save_table(ctx, kind) {
  const ws = ctx.get_ws();
  try {
    const f = kind === 'csv' ? export_csv_file(ws) : export_hledger_file(ws);
    download_text(file_name(kind, ws.as_of), f.text, kind === 'csv' ? 'text/csv' : 'text/plain');
    ctx.notify(ctx.tr(kind === 'csv' ? 'data.saved_csv' : 'data.saved_hledger', { n: f.rows ?? f.planned, bytes: f.bytes }), 'info');
  } catch (e) { ctx.notify(ctx.tr('data.action_failed', { code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA' }), 'error'); }
}

/** Список «что формат не передаёт»: корзины с содержимым, с пометкой «потеряно» или «в виде разовых правил». */
function losses_list(ctx, format, ws) {
  const items = format_losses(format, ws);
  return h('div', { class: 'data-losses' },
    h('p', { class: 'muted', text: ctx.tr(format === 'csv' ? 'data.losses_csv' : 'data.losses_hledger') }),
    items.length === 0 ? h('p', { class: 'muted', text: ctx.tr('data.losses_none') })
      : h('ul', null, items.map((x) => h('li', { text: ctx.tr('data.loss_' + x.id) + ' (' + x.count + ')' + (x.mode === 'materialized' ? ' — ' + ctx.tr('data.loss_materialized') : '') }))));
}

/**
 * Строки о версии движка в файле (FP-17, REQ-016): расхождение с текущей версией — предупреждение, а не отказ; версия не записана — спокойная заметка.
 * @param {object} ctx
 * @param {{engine?: {status: string, warn: boolean, file: string|null, current: string}}} parsed разобранный файл (`inspect_import`)
 */
export function engine_notes(ctx, parsed) {
  const e = parsed?.engine;
  if (e === undefined || e === null) return [];
  if (e.warn) return [h('p', { class: 'banner', role: 'status', text: ctx.tr('data.engine_' + e.status, { file: e.file ?? '', current: e.current }) + ' ' + ctx.tr('data.engine_tail') })];
  if (e.status === 'unknown') return [h('p', { class: 'muted', text: ctx.tr('data.engine_unknown') })];
  return [];
}

/** Диалог «Восстановить»: что будет заменено, подтверждение, итог. Файл новее известного формата — «только для просмотра» (хранилище не меняется). */
function open_restore(ctx, rt, parsed) {
  const st = rt.status();
  const prev = restore_preview({ counts: st.counts, hash: null }, { counts: parsed.counts, hash: parsed.hash });
  const label = (id) => ctx.tr('data.count_' + id);
  const rows = prev.rows.map((r) => h('tr', null, h('th', { scope: 'row', text: label(r.id) }), h('td', { text: String(r.now) }), h('td', { text: String(r.incoming) })));
  const ro = parsed.read_only === true;
  const info = parsed.read_only_info ?? {};
  const unusable = ro && typeof info.unusable === 'string'; // читаемых записей мало: прогноз не построить, кнопки «Открыть» нет
  const lead_key = unusable ? 'data.readonly_unusable' : ro ? (info.newer_format ? 'data.restore_lead_readonly' : 'data.restore_lead_readonly_records') : (parsed.kind === 'journal' ? 'data.restore_lead_journal' : 'data.restore_lead_workspace');
  const act = unusable ? null : ro
    ? h('button', { type: 'button', class: 'btn', text: ctx.tr('data.readonly_open'), onclick: async () => {
      close_dialog();
      const r = await rt.open_readonly(parsed);
      ctx.notify(r.ok ? ctx.tr('data.readonly_opened') : ctx.tr('data.action_failed', { code: r.error }), r.ok ? 'info' : 'error');
    } })
    : h('button', { type: 'button', class: 'btn', text: ctx.tr('data.restore_confirm'), onclick: async () => {
      close_dialog();
      const r = await rt.restore(parsed);
      ctx.notify(r.ok ? ctx.tr('data.restored_ok') : ctx.tr('data.action_failed', { code: r.error }), r.ok ? 'info' : 'error');
    } });
  open_dialog(ctx.tr('data.restore_title'), ctx.tr('data.close'),
    h('p', { text: ctx.tr(lead_key, { format: info.format ?? '', known: 'runway-journal/' + (info.known_version ?? ''), n: info.skipped ?? 0 }) }),
    ro && !unusable && info.skipped > 0 ? h('p', { class: 'muted', text: ctx.tr('data.readonly_skipped', { n: info.skipped }) }) : null,
    ...engine_notes(ctx, parsed),
    table(ctx.tr('data.restore_title'), [ctx.tr('data.restore_what'), ctx.tr('data.restore_now'), ctx.tr('data.restore_file')], rows),
    parsed.kind === 'journal' ? h('p', { class: 'muted', text: ctx.tr('data.restore_hash', { hash: short(parsed.hash) }) }) : null,
    ro ? null : h('p', { class: 'muted', text: ctx.tr('data.restore_warn') }),
    // выбран файл-копия: в нём может лежать копия заменяемого журнала; после восстановления автозапись приостанавливается (журнал-файл, не рабочая область)
    ro || parsed.kind !== 'journal' || chosen_file_name(rt) === null ? null : h('p', { class: 'banner short', role: 'note', text: ctx.tr('backupfile.restore_file_warn', { name: chosen_file_name(rt) }) }),
    h('div', { class: 'row' }, act));
}

async function on_pick(ctx, rt, file) {
  if (file === undefined) return;
  if (file.size > MAX_IMPORT_BYTES) { ctx.notify(ctx.tr('data.file_too_big'), 'error'); return; }
  const read = inspect_import(await file.text());
  if (!read.ok) { ctx.notify(ctx.tr('data.file_bad', { code: read.error }), 'error'); return; }
  open_restore(ctx, rt, typeof file.name === 'string' ? { ...read, file_name: file.name.slice(0, 80) } : read); // имя файла нужно переключателю «Набор данных» (FP-48)
}

/**
 * Постоянная плашка «открыт только для просмотра» на экране «Данные» (FP-17): что отключено, сколько записей пропущено, что в выгрузках.
 * @param {object} ctx
 * @param {{newer_format?: boolean, format?: string, known_version?: number, skipped?: number}} ro сведения `ctx.read_only()`
 */
export function readonly_state_node(ctx, ro) {
  const first = ro.newer_format === true
    ? ctx.tr('data.readonly_state_format', { format: ro.format ?? '', known: 'runway-journal/' + (ro.known_version ?? '') })
    : ctx.tr('data.readonly_state_records');
  return h('div', { class: 'banner', role: 'status', id: 'fp05-ro-note' },
    h('p', { text: first }),
    typeof ro.skipped === 'number' && ro.skipped > 0 ? h('p', { text: ctx.tr('data.readonly_skipped', { n: ro.skipped }) }) : null,
    h('p', { class: 'muted', text: ctx.tr('data.readonly_no_copy') }),
    h('p', { class: 'muted', text: ctx.tr('data.readonly_exports') }));
}

/**
 * Блок «Автозапись в файл-копию» раздела хранения (FP-19, REQ-097): состояние (нет файла / включена / ждёт разрешения / запись не удалась), кнопки
 * «Выбрать файл-копию», «Записать в файл сейчас», «Разрешить запись», «Не использовать файл» и ограничение (Safari и iOS не проверялись). Без `st.file` — `null`.
 */
function render_file_block(ctx, rt, st, ro) {
  const f = st.file;
  if (f === null || f === undefined) return null;
  const target = f.phase === 'ready' || f.phase === 'permission' || f.phase === 'failed';
  const lines = [];
  if (!f.supported) lines.push(h('p', { id: 'fp19-note', class: 'muted', text: ctx.tr('backupfile.unsupported') }));
  else if (!target) lines.push(h('p', { text: ctx.tr('backupfile.none') }));
  else {
    lines.push(h('p', { text: ctx.tr('backupfile.ready', { name: f.name }) }));
    if (f.phase === 'permission') lines.push(h('p', { class: 'banner short', role: 'status', text: ctx.tr(f.permission === 'denied' ? 'backupfile.permission_denied' : 'backupfile.permission_prompt', { name: f.name }) }));
    if (f.phase === 'failed') lines.push(h('p', { class: 'banner short', role: 'alert', text: ctx.tr('backupfile.failed', { name: f.name, reason: reason_text(ctx, f.last_error) }) }));
    if (f.held) lines.push(h('p', { class: 'banner short', role: 'status', text: ctx.tr('backupfile.held', { name: f.name }) }));
    // «В файл пока ничего не записано» только если в ЭТОТ файл правда не писали; записано раньше (до перезагрузки) — число записей из пометки при ссылке
    lines.push(h('p', { text: f.last_ok !== null ? ctx.tr('backupfile.last_ok', { day: f.last_ok.day, n: f.last_ok.count, hash: short(f.last_ok.hash) })
      : f.written_count !== null && f.written_count !== undefined ? ctx.tr('backupfile.written_before', { n: f.written_count }) : ctx.tr('backupfile.no_write_yet') }));
    if (f.pending > 0) lines.push(h('p', { class: 'muted', text: ctx.tr('backupfile.pending', { n: f.pending }) }));
    lines.push(h('p', { class: 'muted', text: ctx.tr(f.remembered ? 'backupfile.remembered' : 'backupfile.not_remembered') }));
  }
  const blocked = ro !== null || !f.supported || f.phase === 'off' || st.mode === 'erased';
  const why = ro !== null ? 'fp05-ro-note' : !f.supported ? 'fp19-note' : null;
  return h('div', { class: 'file-copy', id: 'fp19-file' },
    h('h4', { text: ctx.tr('backupfile.title') }),
    h('p', { class: 'muted', text: ctx.tr('backupfile.lead', { n: f.every_events, minutes: Math.max(1, Math.round(f.every_ms / 60000)) }) }),
    ...lines,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', id: 'fp19-pick', text: ctx.tr(target ? 'backupfile.pick_other' : 'backupfile.pick'), disabled: blocked, 'aria-describedby': blocked ? why : null, onclick: () => file_pick_click(ctx, rt) }),
      target ? h('button', { type: 'button', class: 'btn', id: 'fp19-write', text: ctx.tr('backupfile.write_now'), disabled: ro !== null, 'aria-describedby': ro === null ? null : 'fp05-ro-note', onclick: () => file_write_click(ctx, rt, 'fp19-write') }) : null,
      f.phase === 'permission' ? h('button', { type: 'button', class: 'btn', id: 'fp19-allow', text: ctx.tr('backupfile.allow'), onclick: () => file_allow_click(ctx, rt, 'fp19-allow') }) : null,
      target ? h('button', { type: 'button', class: 'btn', id: 'fp19-forget', text: ctx.tr('backupfile.forget'), onclick: () => file_forget_click(ctx, rt) }) : null),
    h('p', { class: 'muted', text: ctx.tr('backupfile.limit') }));
}

/** Раздел «Хранение и файлы»: где лежит журнал, последняя копия, скачивание и восстановление; ниже — автозапись в файл-копию. */
export function render_storage_section(ctx, rt) {
  const st = rt.status();
  const ws = ctx.get_ws();
  const ro = read_only_info(ctx, rt);
  const file_in = h('input', { id: 'fp05-file', type: 'file', accept: 'application/json,.json' });
  file_in.addEventListener('change', () => on_pick(ctx, rt, file_in.files[0]));
  const lines = [
    ro === null ? null : readonly_state_node(ctx, ro),
    h('p', { text: ctx.tr('data.store_' + st.store_kind, { n: st.count }) }),
    h('p', { text: st.last_backup === null ? ctx.tr('data.copy_none') : ctx.tr('data.copy_last', { day: st.last_backup.day, hash: short(st.last_backup.hash) }) }),
  ];
  if (st.mode === 'paused') lines.push(h('p', { class: 'banner short', role: 'status', text: ctx.tr('data.paused_' + (st.pause_reason ?? 'adopt')) }));
  lines.push(h('p', { class: 'muted', text: ctx.tr('data.engine_line', { version: st.engine.current }) }));
  if (st.engine.stale.length > 0) { // снимки журнала сделаны другой версией движка: не использованы, пересчитаны из записей (FP-17)
    const versions = [...new Set(st.engine.stale.map((x) => x.engine_version))].join(', ');
    lines.push(h('p', { class: 'banner', role: 'status', text: ctx.tr('data.snap_rebuilt', { versions }) }));
  }
  if (st.mode === 'failed') lines.push(h('p', { class: 'banner short', role: 'alert', text: ctx.tr('data.failed', { code: st.error ?? 'store_failed' }) }));
  if (st.write_failed) lines.push(h('p', { class: 'banner short', role: 'alert', text: ctx.tr('data.write_failed', { code: st.error ?? 'store_failed' }) }));
  if (st.foreign) lines.push(h('p', { class: 'banner', role: 'status' }, ctx.tr('data.foreign') + ' ', h('button', { type: 'button', class: 'link', text: ctx.tr('data.foreign_reload'), onclick: () => rt.reload_foreign() })));
  const node = h('section', { class: 'card', id: 'fp05-storage' },
    h('h3', { text: ctx.tr('data.storage_title') }),
    h('p', { class: 'muted', text: ctx.tr('data.storage_lead') }),
    ...lines,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', text: ctx.tr('data.save_journal'), disabled: ro !== null, 'aria-describedby': ro === null ? null : 'fp05-ro-note', onclick: () => save_journal(ctx, rt) }),
      h('button', { type: 'button', class: 'btn', text: ctx.tr('data.save_csv'), onclick: () => save_table(ctx, 'csv') }),
      h('button', { type: 'button', class: 'btn', text: ctx.tr('data.save_hledger'), onclick: () => save_table(ctx, 'hledger') }),
      h('label', { class: 'file', for: 'fp05-file', text: ctx.tr('data.restore_label') }), file_in),
    h('p', { class: 'muted', text: ctx.tr('data.journal_hint') }),
    render_file_block(ctx, rt, st, ro),
    losses_list(ctx, 'csv', ws),
    losses_list(ctx, 'hledger', ws));
  keeper_of(rt).apply(); // поздние перерисовки от хранилища: фокус возвращается, только если он потерян
  return node;
}

/** Раздел «Где что лежит» (REQ-125): отчёт вычисляется из состояния. */
export function render_rights_section(ctx, rt) {
  const rep = rt.status().rights;
  return h('section', { class: 'card', id: 'fp05-rights' },
    h('h3', { text: ctx.tr('data.rights_title') }),
    h('ul', null, rep.rows.map((r) => h('li', { text: ctx.tr(r.key, r.params) }))),
    h('h4', { text: ctx.tr('data.rights_residual') }),
    h('ul', null, rep.residual.map((r) => h('li', { text: ctx.tr(r.key) }))));
}

/** Диалог квитанции удаления. */
function open_receipt(ctx, receipt) {
  const rows = receipt.stores.map((s) => h('tr', null,
    h('th', { scope: 'row', text: ctx.tr('data.store_name_' + s.name) }),
    h('td', { text: s.cleared === true ? ctx.tr('data.receipt_cleared') : ctx.tr('data.receipt_failed') }),
    h('td', { text: s.removed === undefined ? '' : String(s.removed) })));
  open_dialog(ctx.tr('data.receipt_title'), ctx.tr('data.close'),
    h('p', { role: 'status', text: ctx.tr(receipt.erased ? 'data.receipt_done' : 'data.receipt_partial', { date: receipt.date ?? '' }) }),
    h('p', { text: ctx.tr('data.erase_counts', receipt.counts) }),
    table(ctx.tr('data.receipt_title'), [ctx.tr('data.receipt_store'), ctx.tr('data.receipt_state'), ctx.tr('data.receipt_n')], rows),
    h('p', { class: 'banner', role: 'note', text: ctx.tr('data.copies_warning') }),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', text: ctx.tr('data.reload'), onclick: () => location.reload() })));
}

/** Раздел «Удаление данных»: показ «будет удалено …», подтверждение, квитанция. */
export function render_erase_section(ctx, rt) {
  const open_confirm = () => {
    const c = rt.erase_preview();
    open_dialog(ctx.tr('data.erase_title'), ctx.tr('data.close'),
      h('p', { role: 'alert', text: ctx.tr('data.erase_counts', c) }),
      h('p', { text: ctx.tr('data.erase_what') }),
      h('p', { class: 'banner', text: ctx.tr('data.copies_warning') }),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', text: ctx.tr('data.erase_confirm'), onclick: async () => {
        const receipt = await rt.erase();
        open_receipt(ctx, receipt);
      } })));
  };
  const c = counts_of_ws(ctx.get_ws());
  return h('section', { class: 'card', id: 'fp05-erase' },
    h('h3', { text: ctx.tr('data.erase_title') }),
    h('p', { class: 'muted', text: ctx.tr('data.erase_lead', c) }),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', text: ctx.tr('data.erase_button'), onclick: open_confirm })));
}

/** Названия форматов для проверок: список видов потерь (для тестов каталога строк). */
export const LOSS_IDS = Object.freeze([...new Set([...FORMAT_LOSSES.csv.lost, ...FORMAT_LOSSES.hledger.lost, ...FORMAT_LOSSES.hledger.materialized])]);
