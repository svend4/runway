// import_wizard.mjs — мастер импорта (FP-06; REQ-091, REQ-092, REQ-093, REQ-099): CSV и hledger с сухим прогоном и откатом партии.
// Экран только рисует состояние `w` из import_model.mjs (чистая модель, проверяется в Node) и вызывает общий путь записи `ctx.set_ws`.
// Шаги CSV: файл (≤ 5 МБ ДО чтения) → колонки и профиль → отчёт «распознано · отклонено · дубликатов» → «Подтвердить» → «Откатить партию».
// Большой файл (от WORKER_MIN_BYTES) разбирается в Web Worker с откатом на главный поток (FP-18, import_worker_client.mjs); пока идёт разбор, экран
// показывает «Проверяю файл» и не даёт запустить прогон второй раз. Предупреждения сухого прогона (единицы суммы) — над числами отчёта.
// Вкладка hledger: файл → отчёт (или перечень «не поддержано») → «Подтвердить».
// Защита от внедрения: текст из файла (описания операций, названия колонок и счетов) попадает в разметку только через textContent (`h` из dom.mjs);
// inline-стилей и обработчиков-строк нет; профиль из файла — данные без regex и исполняемых полей. Расчёт по введённым данным и правилам, не консультация.

import { h, announce } from './dom.mjs';
import { render_value } from '../engine/verifier.mjs';
import { currency_exponent, format_date } from '../engine/index.mjs';
import { make_nf_fmt, resolve_number_format } from './number_format.mjs';
import {
  MAX_IMPORT_BYTES, WORKER_MIN_BYTES, STEPS, TABS, ENCODINGS, DATE_FORMATS, BUILTIN_PROFILES, REJECT_REASONS, HL_REASONS,
  check_size, reason_id, import_accounts, list_batches, importable_count, select_items, plan_is_current,
  new_wizard, wiz_reset, wiz_csv_load, wiz_csv_set, wiz_csv_back, wiz_csv_run, wiz_csv_run_async, wiz_csv_profile_file, wiz_hl_load, wiz_refresh, wiz_refresh_async, wiz_decide, wiz_commit, wiz_committed, wiz_rollback,
} from './import_model.mjs';
import { create_import_client } from './import_worker_client.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { clock_ports } from './ids.mjs';
// FP-29: часы из CSV и строки обмена в чужой валюте (модель — import_v11.mjs, узлы — import_v11_view.mjs; ветки ниже короткие)
import { V11_PROFILES, is_hours_profile, list_hours_batches } from './import_v11.mjs';
import {
  v11_profile_name, v11_profile_options, v11_reject_text, hours_summary, hours_columns_nodes, fx_columns_nodes, fx_block_of, hours_report_nodes, fx_report_nodes,
} from './import_v11_view.mjs';

const MB = 1024 * 1024;
/** Сколько строк показывать в списках отчёта (остальные считаются, но не рисуются). */
const SHOW_ROWS = 20;
const SHOW_DOUBLES = 50;

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Чистые помощники (без DOM; проверяются в Node)
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Прочитать выбранный файл: размер проверяется ДО чтения содержимого (REQ-091), затем ещё раз по фактической длине.
 * @param {{name?: string, size: number, arrayBuffer: () => Promise<ArrayBuffer>}} file объект `File`
 * @returns {Promise<{ok: true, name: string, bytes: Uint8Array} | {ok: false, error: object}>}
 */
export async function read_picked_file(file) {
  const sz = check_size(file?.size);
  if (!sz.ok) return sz;
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'decode_failed' } } }; }
  const sz2 = check_size(bytes.length);
  if (!sz2.ok) return sz2;
  return { ok: true, name: typeof file.name === 'string' ? file.name : '', bytes };
}

/** Прочитать файл профиля (JSON, до 64 КБ): текст для `wiz_csv_profile_file`. */
export async function read_picked_text(file, limit) {
  if (!Number.isFinite(file?.size) || file.size > limit) return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'profile_too_large', limit } } };
  try { return { ok: true, text: new TextDecoder('utf-8').decode(new Uint8Array(await file.arrayBuffer())) }; } catch { return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'decode_failed' } } }; }
}

/** Человеческий размер файла: «5,2 КБ», «1,4 МБ» (десятичный знак — по языку). */
export function size_text(bytes, lang, nf) {
  const dec = nf === undefined || nf === null ? (lang === 'en' ? '.' : ',') : resolve_number_format(lang, nf).decimal; // десятичный знак — по формату чисел пользователя (REQ-112, FP-16)
  const one = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('.', dec);
  const kb = lang === 'en' ? 'KB' : 'КБ';
  const mb = lang === 'en' ? 'MB' : 'МБ';
  if (bytes < 1024) return bytes + (lang === 'en' ? ' B' : ' Б');
  if (bytes < MB) return one(bytes / 1024) + ' ' + kb;
  return one(bytes / MB) + ' ' + mb;
}

/** Текст отказа по коду канона и причине (без значений из файла). `tr` — функция строк (`ctx.tr`). */
export function error_text(tr, error) {
  if (error === null || error === undefined) return '';
  if (error.ctx?.reason === 'read_only') return tr('ro.refused'); // режим «только чтение» (FP-17): причина, без кода
  const reason = reason_id(error);
  const c = error.ctx ?? {};
  let t = tr('import.err_' + reason, { mb: MAX_IMPORT_BYTES / MB, line: typeof c.line === 'number' ? c.line : '?', count: typeof c.count === 'number' ? c.count : 0 });
  if (reason === 'bad_profile' && Array.isArray(c.errors) && c.errors.length > 0) {
    t += ' ' + c.errors.slice(0, 3).map((e) => String(e.field) + ': ' + String(e.reason)).join('; ') + '.';
  }
  return t + ' (' + String(error.code) + ')';
}

/** Деньги с валютой по правилам языка; с `nf` (`ws.number_format`, REQ-112, FP-16) — в формате чисел пользователя. Без `nf` результат прежний. */
export function money_text(lang, minor, currency, as_of, nf) {
  if (nf === undefined || nf === null) return render_value({ kind: 'money', v: minor, cur: currency, dp: currency_exponent(currency) }, lang, as_of ?? null);
  return make_nf_fmt(lang, currency, as_of ?? '0000-01-01', nf).money(minor);
}

/** Дата `YYYY-MM-DD` словами по правилам языка; пустое значение — «—». */
export function date_text(lang, iso, as_of, nf) {
  return typeof iso === 'string' && iso !== '' ? render_value({ kind: 'date', v: iso }, lang, as_of ?? null, nf ?? null) : '—';
}

/** Три числа отчёта для строки «распознано · отклонено · дубликатов». */
export function report_numbers(report) {
  return { rec: report.recognized, rej: report.rejected, dup: report.duplicates, total: report.rows_total };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Состояние экрана
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Зависимости пакета: состояние мастера и флаги экрана; создаются на каждую регистрацию. `parser` — клиент воркера разбора (по умолчанию настоящий,
 * воркер запускается при первом большом файле; `null` — всегда на главном потоке).
 * @param {{parser?: object|null}} [opts]
 */
export function create_deps(opts = {}) {
  // `focus` (FP-29): после «Подтвердить», «Откатить партию» и выбора в списке узел, на котором стоял фокус, заменяется перерисовкой, а хранилище (FP-05) просит ещё одну позже —
  // хранитель возвращает фокус на узел с тем же `id`, если он потерян (focus_keep.mjs)
  return { w: new_wizard(), busy: false, notice: null, redraw: null, parser: opts.parser === undefined ? create_import_client() : opts.parser, focus: create_focus_keeper(() => clock_ports().now_ms()) };
}

/** Текст предупреждения сухого прогона (`import.w_<код>`) с параметрами из предупреждения; `money` показывает минимальные единицы деньгами. */
export function warning_text(tr, warning, money) {
  if (warning.code === 'amount_scale') {
    // профиль уже читает минимальные единицы: нейтральная формулировка (счёт и файл проверить), а не «возможно прочитана как основные»
    const key = warning.unit === 'minor' ? 'import.w_amount_scale_minor' : 'import.w_amount_scale';
    return tr(key, { peak: money(warning.peak_minor), ref: money(warning.ref_minor), ratio: warning.ratio });
  }
  if (warning.code === 'minor_as_major') return tr('import.w_minor_as_major', { col: warning.col, factor: warning.factor });
  return '';
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Узлы
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const col_options = (tr, header) => [['-1', tr('import.col_none')], ...header.map((n, i) => [String(i), tr('import.col_n', { n: i + 1, name: n === '' ? '…' : n })])];

/** Поле «подпись + выпадающий список». Возвращает `{node, select}`. */
function select_field(id, label, options, value, on_change) {
  const sel = h('select', { id, onchange: () => on_change(sel.value) },
    options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) ? true : null, text })));
  sel.value = String(value);
  return { node: h('div', { class: 'field' }, h('label', { for: id, text: label }), sel), select: sel };
}

/** Узлы без пустых значений (`replaceChildren(null)` вставил бы текст «null»). */
const clean = (nodes) => nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);

/** Заголовок столбца. */
const th = (text) => h('th', { scope: 'col', text });

/** Кнопка. */
const btn = (text, onclick, o = {}) => h('button', { type: 'button', class: o.primary === true ? 'btn primary' : 'btn', onclick, disabled: o.disabled === true ? true : null, 'aria-label': o.label ?? null, id: o.id ?? null, text });

/**
 * Откат партии через общий путь записи. Сообщение ставится до записи: страница перерисуется внутри `ctx.set_ws` и сразу покажет его.
 * @returns {boolean} откат выполнен
 */
export function rollback_ui(ctx, deps, batch_id) {
  deps.focus?.request('import-title'); // кнопка откаченной партии исчезает: фокус уходит на заголовок мастера
  // режим «только чтение» (FP-17): причина отказа — общий текст ro.refused, а не «Откат не выполнен» без причины
  const fail = (error = null) => {
    const key = error?.ctx?.reason === 'read_only' ? 'ro.refused' : 'import.rb_failed';
    deps.notice = { kind: 'error', key, params: {} }; ctx.notify(ctx.tr(key), 'error'); if (deps.redraw !== null) deps.redraw(); return false;
  };
  const r = wiz_rollback(deps.w, ctx.get_ws(), batch_id);
  if (!r.ok) return fail();
  const hours = r.removed.hours > 0 || r.removed.kept > 0 || r.removed.gone > 0; // партия часов (FP-29): возвращены периоды, а не факты
  const rb_key = !hours ? 'import.rolled_back' : (r.removed.kept > 0 ? 'importv11.h_rolled_back_kept' : 'importv11.h_rolled_back');
  const rb_params = hours ? { n: r.removed.hours, kept: r.removed.kept, id: batch_id } : { n: r.removed.facts, id: batch_id };
  deps.notice = { kind: 'info', key: rb_key, params: rb_params };
  deps.busy = true;
  let s;
  try { s = ctx.set_ws(r.ws, { reason: 'import_rollback' }); } finally { deps.busy = false; }
  if (!s.ok) return fail(s.error);
  ctx.notify(ctx.tr(rb_key, rb_params), 'info');
  if (deps.redraw !== null) deps.redraw();
  return true;
}

/**
 * Экран мастера как блок слота `data.sections`. Узел перерисовывает сам себя при смене шага; после записи `ctx.set_ws` страница строит блок заново
 * из того же состояния (`deps.w`), поэтому шаг и результат не теряются.
 * @param {object} ctx контекст расширений
 * @param {ReturnType<typeof create_deps>} deps
 * @returns {HTMLElement}
 */
export function render_wizard(ctx, deps) {
  const w = deps.w;
  const root = h('section', { class: 'card import-wizard', 'aria-labelledby': 'import-title' });
  let focus_el = null;

  const ws = () => ctx.get_ws();
  const redraw = () => { focus_el = null; root.replaceChildren(...clean(build())); if (focus_el !== null && typeof focus_el.focus === 'function') focus_el.focus(); deps.focus?.apply(); };
  deps.redraw = redraw;
  const flash = (notice) => { deps.notice = notice; };

  // ── общие части ─────────────────────────────────────────────────────────────────────────────────────────────────

  function tabs() {
    return h('div', { class: 'seg import-tabs', role: 'group', 'aria-label': ctx.tr('import.tabs_label') }, TABS.map((tab) => h('button', {
      type: 'button', 'aria-pressed': w.tab === tab ? 'true' : 'false', id: 'import-tab-' + tab, text: ctx.tr('import.tab_' + tab),
      onclick: () => { w.tab = tab; flash(null); redraw(); },
    })));
  }

  function step_line(st, steps) {
    const at = steps.indexOf(st.step);
    return h('ol', { class: 'import-steps', 'aria-label': ctx.tr('import.steps_label') }, steps.map((s, i) => h('li', {
      'aria-current': i === at ? 'step' : null, class: i === at ? 'now' : (i < at ? 'past' : ''),
      text: ctx.tr('import.step_n', { n: i + 1, name: ctx.tr('import.step_' + s) }),
    })));
  }

  function notice_node() {
    if (deps.notice === null) return null;
    return h('p', { class: deps.notice.kind === 'error' ? 'banner short' : 'banner', role: deps.notice.kind === 'error' ? 'alert' : 'status', text: ctx.tr(deps.notice.key, deps.notice.params) });
  }

  const error_node = (st) => (st.error === null ? null : h('p', { class: 'banner short', role: 'alert', id: 'import-error', text: error_text(ctx.tr, st.error) }));

  function file_input(id, accept, on_file) {
    const inp = h('input', { id, type: 'file', accept });
    inp.addEventListener('change', () => { const f = inp.files?.[0]; if (f !== undefined) on_file(f); });
    return inp;
  }

  // ── CSV ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  // Чтение файла идёт в фоне (правило 10 пакета FP-18): за это время страницу могли перестроить или сменить набор данных. Ответ пишется в мастер,
  // с которого начали выбор (`owner`); если набор сменили (`adopt`), файл относится к прежнему набору и отбрасывается. Живой экран рисуется через
  // `redraw_live`, а не через `redraw` этого вызова: тот рисует в узел, который уже мог отсоединиться (FP-50, D-1…D-3).
  async function pick_csv(file) {
    flash(null);
    const owner = w;
    const r = await read_picked_file(file);
    if (deps.w !== owner) return;
    if (!r.ok) { owner.csv.error = r.error; owner.csv.file = null; owner.csv.step = 'file'; redraw_live(); announce(error_text(ctx.tr, r.error)); return; }
    wiz_csv_load(owner, ws(), r);
    redraw_live();
    announce(ctx.tr('import.started', { name: owner.csv.file?.name ?? '' }));
  }

  async function pick_profile(file) {
    flash(null);
    const owner = w;
    const r = await read_picked_text(file, 64 * 1024);
    if (deps.w !== owner) return;
    if (!r.ok) { owner.csv.error = r.error; redraw_live(); return; }
    wiz_csv_profile_file(owner, ws(), r.text);
    redraw_live();
  }

  const set_csv = (patch) => {
    flash(null);
    // перерисовка заменяет выпадающий список, на котором стоял фокус: просим вернуть его узлу с тем же id (FP-29, WCAG 2.4.3)
    const active = globalThis.document?.activeElement;
    if (typeof active?.id === 'string' && active.id !== '' && typeof root.contains === 'function' && root.contains(active)) deps.focus?.request(active.id);
    wiz_csv_set(w, ws(), patch);
    redraw();
  };

  function sample_table(st) {
    const sn = st.sniff;
    if (sn === null) return null;
    const head = sn.header;
    const rows = sn.preview.map((r) => h('tr', null, head.map((_, i) => h('td', { text: String(r[i] ?? '') }))));
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl import-sample' },
      h('caption', { text: ctx.tr('import.sample_caption', { n: sn.preview.length, total: sn.rows_total }) }),
      h('thead', null, h('tr', null, head.map((c, i) => h('th', { scope: 'col', text: c === '' ? ctx.tr('import.col_n', { n: i + 1, name: '…' }) : c })))),
      h('tbody', null, rows)));
  }

  /** Название профиля для выбора и подсказки: встроенные — из каталога мастера, профили v1.1 — из каталога `importv11`. */
  const profile_label = (id) => (Object.hasOwn(BUILTIN_PROFILES, id) ? ctx.tr('import.pf_' + id.replaceAll('-', '_')) : v11_profile_name(ctx.tr, id));

  /** Причина отклонения строки: общие причины мастера, затем причины v1.1 (часы и обмен), иначе «другая». */
  const reject_label = (reason) => (REJECT_REASONS.includes(reason) ? ctx.tr('import.rj_' + reason) : (v11_reject_text(ctx.tr, reason) ?? ctx.tr('import.rj_other')));

  function profile_summary(p) {
    if (is_hours_profile(p)) return hours_summary(ctx.tr, p);
    const lines = [
      ctx.tr('import.ps_delim', { v: p.delimiter === '\t' ? 'TAB' : p.delimiter }),
      ctx.tr('import.ps_date', { col: String(p.date.col), fmt: p.date.fmt }),
      p.amount.unit === 'minor' ? ctx.tr('import.ps_amount_minor', { col: String(p.amount.col) }) : ctx.tr('import.ps_amount', { col: p.amount.mode === 'signed' ? String(p.amount.col) : String(p.amount.debit) + ' / ' + String(p.amount.credit), dec: p.amount.decimal, th: p.amount.thousands === undefined ? '∅' : (p.amount.thousands === ' ' ? '␣' : p.amount.thousands) }),
      ctx.tr('import.ps_desc', { cols: p.desc.cols.map(String).join(', ') }),
    ];
    if (p.filter !== undefined) lines.push(ctx.tr('import.ps_filter', { col: String(p.filter.col), equals: String(p.filter.equals) }));
    return h('ul', { class: 'plain import-profile-summary' }, lines.map((t) => h('li', { text: t })));
  }

  function columns_form(st) {
    const sn = st.sniff;
    const m = st.mapping;
    const accounts = import_accounts(ws());
    const kids = [];
    kids.push(h('p', { class: 'muted', text: ctx.tr('import.f_name', { name: st.file.name, size: size_text(st.file.bytes.length, ctx.lang(), ws()?.number_format), n: sn === null ? 0 : sn.rows_total }) }));
    const enc = select_field('import-encoding', ctx.tr('import.f_encoding'), ENCODINGS.map((e) => [e, e]), st.encoding, (v) => set_csv({ encoding: v }));
    const delim = select_field('import-delimiter', ctx.tr('import.f_delimiter'), [['auto', ctx.tr('import.dl_auto')], [',', ctx.tr('import.dl_comma')], [';', ctx.tr('import.dl_semi')], ['\t', ctx.tr('import.dl_tab')]], st.delimiter, (v) => set_csv({ delimiter: v }));
    const skip = h('input', { id: 'import-skip', type: 'text', inputmode: 'numeric', value: String(st.skip), size: 4 });
    skip.addEventListener('change', () => { const n = Number(String(skip.value).trim()); set_csv({ skip: Number.isInteger(n) ? n : st.skip }); });
    kids.push(h('div', { class: 'import-row' }, enc.node, delim.node, h('div', { class: 'field' }, h('label', { for: 'import-skip', text: ctx.tr('import.f_skip') }), skip)));
    if (sn === null) return kids;

    kids.push(sample_table(st));
    const acc = select_field('import-account', ctx.tr('import.f_account'), accounts.map((a) => [a.account_id, (a.name ?? a.account_id) + ' · ' + a.currency]), st.account_id ?? '', (v) => set_csv({ account_id: v }));
    const prof_opts = [['custom', ctx.tr('import.pf_custom')], ...Object.keys(BUILTIN_PROFILES).map((id) => [id, ctx.tr('import.pf_' + id.replaceAll('-', '_'))]), ...v11_profile_options(ctx.tr)];
    if (st.profile_file !== null) prof_opts.push(['file', ctx.tr('import.pf_file')]);
    const prof = select_field('import-profile', ctx.tr('import.f_profile'), prof_opts, st.profile_choice, (v) => set_csv({ profile_choice: v }));
    kids.push(h('div', { class: 'import-row' }, acc.node, prof.node));
    if (st.recommended !== null && st.profile_choice !== st.recommended) kids.push(h('p', { class: 'muted', text: ctx.tr('import.pf_fits', { name: profile_label(st.recommended) }) }));
    kids.push(h('div', { class: 'field' }, h('label', { for: 'import-profile-file', text: ctx.tr('import.f_profile_file') }), file_input('import-profile-file', 'application/json,.json', pick_profile),
      h('p', { class: 'muted', text: ctx.tr('import.profile_note') })));

    if (st.profile_choice === 'custom') {
      const cols = col_options(ctx.tr, sn.header);
      const col_field = (id, key, label) => select_field(id, ctx.tr(label), cols, m[key], (v) => set_csv({ [key]: Number(v) }));
      kids.push(col_field('import-date-col', 'date_col', 'import.f_date_col').node);
      kids.push(select_field('import-date-fmt', ctx.tr('import.f_date_fmt'), DATE_FORMATS.map((f) => [f, f]), m.date_fmt, (v) => set_csv({ date_fmt: v })).node);
      kids.push(select_field('import-amount-mode', ctx.tr('import.f_amount_mode'), [['signed', ctx.tr('import.am_signed')], ['debit_credit', ctx.tr('import.am_debit_credit')]], m.amount_mode, (v) => set_csv({ amount_mode: v })).node);
      if (m.amount_mode === 'signed') {
        kids.push(col_field('import-amount-col', 'amount_col', 'import.f_amount_col').node);
        kids.push(select_field('import-amount-unit', ctx.tr('import.f_amount_unit'), [['major', ctx.tr('import.au_major')], ['minor', ctx.tr('import.au_minor')]], m.amount_unit ?? 'major', (v) => set_csv({ amount_unit: v })).node);
        kids.push(h('p', { class: 'muted', text: ctx.tr('import.au_hint') }));
      } else { kids.push(col_field('import-debit-col', 'debit_col', 'import.f_debit_col').node); kids.push(col_field('import-credit-col', 'credit_col', 'import.f_credit_col').node); }
      kids.push(h('div', { class: 'import-row' },
        select_field('import-decimal', ctx.tr('import.f_decimal'), [['.', ctx.tr('import.sep_dot')], [',', ctx.tr('import.sep_comma')]], m.decimal, (v) => set_csv({ decimal: v })).node,
        select_field('import-thousands', ctx.tr('import.f_thousands'), [['', ctx.tr('import.sep_none')], [' ', ctx.tr('import.sep_space')], [',', ctx.tr('import.sep_comma')], ['.', ctx.tr('import.sep_dot')]], m.thousands, (v) => set_csv({ thousands: v })).node));
      kids.push(select_field('import-currency-mode', ctx.tr('import.f_currency_mode'), [['column', ctx.tr('import.cm_column')], ['account', ctx.tr('import.cm_account')]], m.currency_mode, (v) => set_csv({ currency_mode: v })).node);
      if (m.currency_mode === 'column') kids.push(col_field('import-currency-col', 'currency_col', 'import.f_currency_col').node);
      kids.push(select_field('import-desc-col', ctx.tr('import.f_desc_col'), cols, m.desc_cols[0] ?? -1, (v) => set_csv({ desc_cols: Number(v) >= 0 ? [Number(v)] : [] })).node);
      const rules = h('textarea', { id: 'import-rules', rows: 3, 'aria-describedby': 'import-rules-hint' });
      rules.value = m.rules_text;
      rules.addEventListener('change', () => { st.mapping.rules_text = rules.value; });
      kids.push(h('div', { class: 'field' }, h('label', { for: 'import-rules', text: ctx.tr('import.f_rules') }), rules, h('p', { id: 'import-rules-hint', class: 'muted', text: ctx.tr('import.rules_hint') })));
      kids.push(...fx_columns_nodes(ctx, st, ws(), set_csv, null)); // FP-29: строки в чужой валюте — обмен двумя ногами
    } else {
      const p = st.profile_choice === 'file' ? st.profile_file : (Object.hasOwn(BUILTIN_PROFILES, st.profile_choice) ? BUILTIN_PROFILES[st.profile_choice] : V11_PROFILES[st.profile_choice]);
      if (is_hours_profile(p)) kids.push(...hours_columns_nodes(ctx, p, st, ws(), set_csv)); // FP-29: профиль «часы» — описание и выбор потока
      else {
        kids.push(profile_summary(p));
        kids.push(...fx_columns_nodes(ctx, st, ws(), set_csv, fx_block_of(st.profile_choice, st.profile_file)));
        if (st.profile_choice === 'runway-csv-1') kids.push(h('p', { class: 'banner', role: 'status', id: 'import-runway-hint', text: ctx.tr('import.runway_hint') }));
      }
    }
    return kids;
  }

  /** Разбор в фоне нужен, если есть клиент воркера и файл не меньше порога; иначе — как раньше, синхронно на главном потоке. */
  const is_big = (st) => deps.parser !== null && st.file !== null && st.file.bytes.length >= WORKER_MIN_BYTES;

  /**
   * Перерисовать ЖИВОЙ экран после ответа фонового разбора. Пока файл проверялся, страницу могли перестроить (запись данных другим путём, уход на другой
   * экран и возврат): `render_wizard` вызван заново с теми же `deps`, а замкнутая `redraw` этого вызова рисует в уже отсоединённый узел. Живой экран —
   * тот, что зарегистрировал себя в `deps.redraw` последним (как делают `confirm` и `rollback_ui`).
   */
  const redraw_live = () => { if (deps.redraw !== null) deps.redraw(); };

  /** «Проверить (сухой прогон)»: большой файл разбирается в фоне (экран показывает «Проверяю файл» и не принимает второй запуск). */
  function run_check() {
    flash(null);
    if (!is_big(w.csv)) { wiz_csv_run(w, ws()); redraw(); return; }
    const p = wiz_csv_run_async(w, ws(), deps.parser);
    redraw();
    p.then((r) => { if (r.cancelled === true) return; redraw_live(); announce(r.ok ? ctx.tr('import.checked') : error_text(ctx.tr, r.error)); });
  }

  /** Устаревший отчёт (данные менялись) пересчитывается: большой файл — в фоне, остальное — сразу; решения о двойниках сохраняются. */
  function refresh_plans() {
    for (const tab of TABS) {
      const st = w[tab];
      if (tab === 'csv' && st.checking) continue; // пересчёт уже идёт
      if (tab === 'csv' && is_big(st) && st.plan !== null && st.step === 'report' && !plan_is_current(st.plan, ws())) {
        const p = wiz_refresh_async(w, ws(), deps.parser);
        if (p !== null) p.then((r) => { if (r.cancelled !== true) redraw_live(); });
        continue;
      }
      wiz_refresh(w, tab, ws());
    }
  }

  function csv_view() {
    const st = w.csv;
    if (st.step === 'report' && st.plan === null) st.step = 'columns'; // пересчёт после правки данных не удался: назад к колонкам
    const kids = [step_line(st, STEPS), error_node(st)];
    if (st.checking) kids.push(h('p', { class: 'banner', role: 'status', id: 'import-checking', text: ctx.tr('import.checking') }));
    if (st.step === 'file' || st.file === null) {
      kids.push(h('div', { class: 'field' }, h('label', { for: 'import-file', text: ctx.tr('import.f_file') }), file_input('import-file', '.csv,text/csv,text/plain', pick_csv),
        h('p', { class: 'muted', text: ctx.tr('import.limit', { mb: MAX_IMPORT_BYTES / MB }) })));
      return kids;
    }
    if (st.step === 'columns') {
      kids.push(...columns_form(st));
      const run = btn(ctx.tr('import.check'), run_check, { primary: true, id: 'import-check', disabled: st.sniff === null || st.account_id === null || st.checking });
      kids.push(h('div', { class: 'actions' }, btn(ctx.tr('import.other_file'), () => { flash(null); wiz_reset(w, 'csv'); redraw(); }), run));
      return kids;
    }
    if (st.step === 'report' && st.plan !== null) {
      kids.push(...report_nodes('csv', st));
      kids.push(h('div', { class: 'actions' },
        btn(ctx.tr('import.back'), () => { flash(null); wiz_csv_back(w); redraw(); }),
        btn(ctx.tr('import.other_file'), () => { flash(null); wiz_reset(w, 'csv'); redraw(); }),
        confirm_button('csv', st)));
      return kids;
    }
    if (st.step === 'done') { kids.push(...done_nodes('csv', st)); return kids; }
    return kids;
  }

  // ── hledger ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Журнал hledger: то же, что `pick_csv` (владелец, отбрасывание при смене набора, живой экран через `redraw_live`). */
  async function pick_hl(file) {
    flash(null);
    const owner = w;
    const r = await read_picked_file(file);
    if (deps.w !== owner) return;
    if (!r.ok) { owner.hledger.error = r.error; owner.hledger.file = null; owner.hledger.step = 'file'; owner.hledger.unsupported = []; redraw_live(); announce(error_text(ctx.tr, r.error)); return; }
    wiz_hl_load(owner, ws(), r);
    redraw_live();
    announce(ctx.tr('import.started', { name: owner.hledger.file?.name ?? '' }));
  }

  function unsupported_nodes(st) {
    const items = st.unsupported.slice(0, SHOW_ROWS * 5).map((u) => h('li', {
      text: (u.line === null ? ctx.tr('import.hl_line_none') : ctx.tr('import.hl_line', { line: u.line })) + ' — ' + ctx.tr('import.hl_why_' + (HL_REASONS.includes(u.reason) ? u.reason : 'other')),
    }));
    return [
      h('h4', { id: 'import-unsupported-title', text: ctx.tr('import.hl_unsupported_title', { n: st.unsupported.length }) }),
      h('p', { class: 'muted', text: ctx.tr('import.hl_unsupported_note') }),
      h('ul', { class: 'import-unsupported', 'aria-labelledby': 'import-unsupported-title' }, items),
      st.unsupported.length > items.length ? h('p', { class: 'muted', text: ctx.tr('import.more', { n: st.unsupported.length - items.length }) }) : null,
    ];
  }

  function hl_view() {
    const st = w.hledger;
    const kids = [h('p', { class: 'muted', text: ctx.tr('import.hl_intro') }), error_node(st)];
    if (st.step === 'file' || st.file === null) {
      kids.push(h('div', { class: 'field' }, h('label', { for: 'import-hl-file', text: ctx.tr('import.f_file_hl') }), file_input('import-hl-file', '.journal,.hledger,.j,.txt,text/plain', pick_hl),
        h('p', { class: 'muted', text: ctx.tr('import.limit', { mb: MAX_IMPORT_BYTES / MB }) })));
      return kids;
    }
    if (st.step === 'report' && st.plan === null) {
      if (st.unsupported.length > 0) kids.push(...unsupported_nodes(st));
      kids.push(h('div', { class: 'actions' }, btn(ctx.tr('import.other_file'), () => { flash(null); wiz_reset(w, 'hledger'); redraw(); }, { primary: true })));
      return kids;
    }
    if (st.step === 'report') {
      kids.push(...report_nodes('hledger', st));
      kids.push(h('div', { class: 'actions' }, btn(ctx.tr('import.other_file'), () => { flash(null); wiz_reset(w, 'hledger'); redraw(); }), confirm_button('hledger', st)));
      return kids;
    }
    if (st.step === 'done') { kids.push(...done_nodes('hledger', st)); return kids; }
    return kids;
  }

  // ── отчёт сухого прогона ────────────────────────────────────────────────────────────────────────────────────────

  function report_nodes(tab, st) {
    const plan = st.plan;
    const rp = plan.report;
    const as_of = ws()?.as_of;
    const nf = ws()?.number_format; // формат чисел и дат пользователя (REQ-112, FP-16)
    const money = (minor, cur) => money_text(ctx.lang(), minor, cur, as_of, nf);
    const cur = plan.currency ?? (plan.candidates[0]?.currency ?? ws()?.decision_currency ?? 'EUR');
    const n = report_numbers(rp);
    const out = [];
    out.push(h('h4', { id: 'import-report-title', text: ctx.tr('import.rep_title') }));
    out.push(h('p', { class: 'import-rep-line', id: 'import-rep-line', role: 'status', text: ctx.tr('import.rep_line', n) }));
    out.push(h('p', { class: 'muted', id: 'import-rep-total', text: ctx.tr('import.rep_total', n) }));
    // где разобран большой файл: в Web Worker или на основном потоке (причина отката — закрытый код); без этой строки путь виден только в DevTools
    if (plan.kind === 'csv' && plan.parse !== undefined && plan.source.size >= WORKER_MIN_BYTES) {
      out.push(h('p', { class: 'muted', id: 'import-parse-path', text: plan.parse.via === 'worker' ? ctx.tr('import.parse_worker') : ctx.tr('import.parse_main', { reason: plan.parse.reason ?? '—' }) }));
    }
    // предупреждения: до подтверждения стоит проверить единицы суммы (текст из файла — только имя колонки, в разметку идёт через textContent)
    for (const wn of rp.warnings ?? []) {
      const msg = warning_text(ctx.tr, wn, (m) => money(m, cur));
      if (msg !== '') out.push(h('p', { class: 'banner short', role: 'alert', id: 'import-warn-' + wn.code, text: msg }));
    }
    if ((rp.by_reason.filtered_out ?? 0) > 0) out.push(h('p', { class: 'muted', id: 'import-rep-filtered', text: ctx.tr('import.rep_filtered', { n: rp.by_reason.filtered_out }) }));
    if (rp.doubles > 0) out.push(h('p', { id: 'import-rep-doubles', text: ctx.tr('import.rep_doubles', { n: rp.doubles }) }));
    if (rp.from !== null) out.push(h('p', { class: 'muted', text: ctx.tr('import.rep_range', { from: date_text(ctx.lang(), rp.from, as_of, nf), to: date_text(ctx.lang(), rp.to, as_of, nf) }) }));
    if (plan.kind === 'csv') out.push(h('p', { class: 'muted', text: ctx.tr('import.rep_net', { net: money(rp.net_minor, cur) }) }));
    if (rp.overlap_days > 0) out.push(h('p', { class: 'muted', text: ctx.tr('import.rep_overlap', { days: rp.overlap_days }) }));
    if (rp.gap_days > 0) out.push(h('p', { class: 'muted', text: ctx.tr('import.rep_gap', { days: rp.gap_days }) }));
    if (rp.covered_by_anchor > 0) out.push(h('p', { class: 'banner', role: 'status', text: ctx.tr('import.rep_covered', { n: rp.covered_by_anchor }) }));
    out.push(...(plan.kind === 'hours' ? hours_report_nodes(ctx, plan, ws()) : fx_report_nodes(ctx, plan, ws()))); // FP-29: периоды часов / обмены двумя ногами
    if (plan.extras !== null) {
      const c = plan.extras.counts;
      out.push(h('p', { text: ctx.tr('import.hl_extras', { acc: c.accounts_new, anc: c.anchors.new, fx: c.rates.new }) }));
      if (c.rules_found + c.plans_found > 0) out.push(h('p', { class: 'banner', role: 'status', text: ctx.tr('import.hl_not_moved', { rules: c.rules_found, plans: c.plans_found }) }));
    }
    // отклонённые строки: номер и причина, без текста из файла
    if (rp.rejected > 0) {
      const rows = rp.reject_rows.slice(0, SHOW_ROWS).map((r) => h('tr', null,
        h('td', { class: 'num', text: String(r.row) }), h('td', { text: reject_label(r.reason) })));
      out.push(h('details', { class: 'import-rejects' },
        h('summary', { text: ctx.tr('import.rej_title', { n: rp.rejected }) }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('caption', { class: 'sr-only', text: ctx.tr('import.rej_title', { n: rp.rejected }) }),
          h('thead', null, h('tr', null, th(ctx.tr('import.th_row')), th(ctx.tr('import.th_why')))),
          h('tbody', null, rows))),
        rp.rejected > SHOW_ROWS ? h('p', { class: 'muted', text: ctx.tr('import.more', { n: rp.rejected - SHOW_ROWS }) }) : null));
    }
    // возможные двойники: решение по каждому
    const doubles = plan.dry.recognized_items.filter((c) => c.double !== null && c.double !== undefined);
    if (doubles.length > 0) {
      const rows = doubles.slice(0, SHOW_DOUBLES).map((c) => {
        const accepted = st.decisions[c.row] === 'accept';
        const set = (d) => () => { wiz_decide(w, tab, c.row, d); redraw(); };
        return h('tr', null,
          h('td', { text: date_text(ctx.lang(), format_date(c.date), as_of, nf) }),
          h('td', { class: 'num', text: money(c.amount_minor, c.currency) }),
          h('td', { class: 'import-desc', text: c.desc }),
          h('td', null, h('div', { class: 'seg', role: 'group', 'aria-label': ctx.tr('import.dbl_row_label', { row: c.row }) },
            h('button', { type: 'button', 'aria-pressed': accepted ? 'false' : 'true', onclick: set('skip'), text: ctx.tr('import.dbl_skip') }),
            h('button', { type: 'button', 'aria-pressed': accepted ? 'true' : 'false', onclick: set('accept'), text: ctx.tr('import.dbl_accept') }))));
      });
      out.push(h('details', { class: 'import-doubles', open: true },
        h('summary', { text: ctx.tr('import.dbl_title', { n: doubles.length }) }),
        h('p', { class: 'muted', text: ctx.tr('import.dbl_hint') }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('caption', { class: 'sr-only', text: ctx.tr('import.dbl_title', { n: doubles.length }) }),
          h('thead', null, h('tr', null, th(ctx.tr('import.th_date')), th(ctx.tr('import.th_amount')), th(ctx.tr('import.th_desc')), th(ctx.tr('import.th_decision')))),
          h('tbody', null, rows))),
        doubles.length > SHOW_DOUBLES ? h('p', { class: 'muted', text: ctx.tr('import.more', { n: doubles.length - SHOW_DOUBLES }) }) : null));
    }
    // что будет записано (первые строки; описание — только текстом)
    const items = select_items(plan, st.decisions);
    if (items.length > 0) {
      const rows = items.slice(0, 10).map((c) => h('tr', null,
        h('td', { text: date_text(ctx.lang(), format_date(c.date), as_of, nf) }),
        h('td', { class: 'num', text: money(c.amount_minor, c.currency) }),
        h('td', { class: 'import-desc', text: c.desc })));
      out.push(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl import-preview' },
        h('caption', { text: ctx.tr('import.pv_title', { n: Math.min(10, items.length), total: items.length }) }),
        h('thead', null, h('tr', null, th(ctx.tr('import.th_date')), th(ctx.tr('import.th_amount')), th(ctx.tr('import.th_desc')))),
        h('tbody', null, rows))));
    }
    out.push(h('p', { class: 'muted', id: 'import-unchanged', text: ctx.tr('import.rep_unchanged') }));
    return out;
  }

  function confirm_button(tab, st) {
    const count = importable_count(st.plan, st.decisions);
    const x = st.plan.extras;
    const extra = x === null ? 0 : x.accounts_new.length + x.anchors_new.length + x.rates_new.length;
    return btn(ctx.tr('import.confirm', { n: count }), () => confirm(tab), { primary: true, id: 'import-confirm', disabled: (count === 0 && extra === 0) || st.checking === true });
  }

  // ── запись и откат ──────────────────────────────────────────────────────────────────────────────────────────────

  function confirm(tab) {
    const st = w[tab];
    flash(null);
    const r = wiz_commit(w, tab, ws(), { new_id: ctx.new_id });
    if (!r.ok) { st.error = r.error; redraw(); announce(error_text(ctx.tr, r.error)); return; }
    deps.busy = true;
    deps.focus?.request('import-title'); // «Подтвердить» исчезает вместе с шагом отчёта: фокус уходит на заголовок мастера
    let s;
    try { s = ctx.set_ws(r.ws, { reason: 'import' }); } finally { deps.busy = false; }
    if (!s.ok) { st.error = s.error; deps.redraw(); return; }
    wiz_committed(w, tab, r.batch);
    const ck = r.batch.what === 'hours' ? 'importv11.h_committed' : 'import.committed'; // партия часов (FP-29) считает периоды, а не факты
    flash({ kind: 'info', key: ck, params: { n: r.batch.facts } });
    ctx.notify(ctx.tr(ck, { n: r.batch.facts }), 'info');
    deps.redraw();
  }

  function done_nodes(tab, st) {
    const res = st.result;
    const out = [h('h4', { text: ctx.tr('import.done_title') })];
    if (res !== null) {
      const hrs = res.what === 'hours';
      out.push(h('p', { id: 'import-done-line', role: 'status', text: hrs ? ctx.tr('importv11.h_done_text', { n: res.facts, id: res.batch_id }) : ctx.tr('import.done_text', { n: res.facts, id: res.batch_id }) }));
      out.push(h('p', { class: 'muted', text: hrs ? ctx.tr('importv11.h_done_hint') : ctx.tr('import.done_hint') }));
    }
    const live = res !== null && (list_batches(ws()).some((b) => b.batch_id === res.batch_id) || list_hours_batches(ws()).some((b) => b.batch_id === res.batch_id));
    out.push(h('div', { class: 'actions' },
      live ? btn(ctx.tr('import.rollback'), () => rollback(res.batch_id), { id: 'import-rollback', label: ctx.tr('import.rollback_label', { id: res.batch_id }) }) : null,
      btn(ctx.tr('import.other_file'), () => { flash(null); wiz_reset(w, tab); redraw(); }, { primary: !live })));
    return out;
  }

  const rollback = (batch_id) => rollback_ui(ctx, deps, batch_id);

  function build() {
    if (ws() === null) return [h('h3', { id: 'import-title', tabindex: '-1', text: ctx.tr('import.title') }), h('p', { class: 'muted', text: ctx.tr('import.no_data') })];
    if (!deps.busy) refresh_plans(); // рабочая область менялась: отчёт пересчитывается, а не устаревает
    return [
      h('h3', { id: 'import-title', tabindex: '-1', text: ctx.tr('import.title') }),
      h('p', { class: 'muted', text: ctx.tr('import.intro') }),
      h('p', { class: 'muted', text: ctx.tr('import.privacy') }),
      tabs(),
      notice_node(),
      ...(w.tab === 'hledger' ? hl_view() : csv_view()),
    ];
  }

  root.replaceChildren(...clean(build()));
  deps.focus?.apply(); // поздняя перерисовка страницы после записи: фокус возвращается, только если он потерян
  return root;
}

/**
 * Список партий часов (поле рабочей области `hours_imports`, FP-29) с кнопкой «Откатить»; `null`, если партий нет. Партия хранится в данных, поэтому откат работает
 * и после перезагрузки страницы: прежние значения возвращаются там, где сейчас записано внесённое импортом, а исправленное вами потом остаётся.
 */
export function render_hours_batches(ctx, deps) {
  const ws = ctx.get_ws();
  if (ws === null) return null;
  const batches = list_hours_batches(ws);
  if (batches.length === 0) return null;
  const as_of = ws.as_of;
  const nf = ws.number_format;
  const rows = batches.slice(-SHOW_ROWS).reverse().map((b) => h('tr', null,
    h('td', { class: 'import-batch-id', text: b.batch_id }),
    h('td', { class: 'num', text: String(b.count) }),
    h('td', { text: date_text(ctx.lang(), b.from, as_of, nf) + ' — ' + date_text(ctx.lang(), b.to, as_of, nf) }),
    h('td', null, btn(ctx.tr('import.rollback'), () => { rollback_ui(ctx, deps, b.batch_id); }, { label: ctx.tr('import.rollback_label', { id: b.batch_id }) }))));
  return h('section', { class: 'card import-batches', id: 'import-hours-batches', 'aria-labelledby': 'import-hours-batches-title' },
    h('h3', { id: 'import-hours-batches-title', text: ctx.tr('importv11.hb_title') }),
    h('p', { class: 'muted', text: ctx.tr('importv11.hb_hint') }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: ctx.tr('importv11.hb_title') }),
      h('thead', null, h('tr', null, th(ctx.tr('import.th_batch')), th(ctx.tr('importv11.hb_count')), th(ctx.tr('import.th_period')), th(ctx.tr('import.th_decision')))),
      h('tbody', null, rows))));
}

/**
 * Список партий импорта (по `batch_id` фактов рабочей области) с кнопкой «Откатить»; `null`, если партий нет.
 * Работает и после перезагрузки страницы: откатывает факты партии (счета, якоря и курсы, внесённые hledger-партией, остаются, если сессия потеряна).
 */
export function render_batches(ctx, deps) {
  const ws = ctx.get_ws();
  if (ws === null) return null;
  const batches = list_batches(ws);
  if (batches.length === 0) return null;
  const as_of = ws.as_of;
  const nf = ws.number_format;
  const rows = batches.slice(-SHOW_ROWS).reverse().map((b) => h('tr', null,
    h('td', { class: 'import-batch-id', text: b.batch_id }),
    h('td', { class: 'num', text: String(b.count) }),
    h('td', { text: date_text(ctx.lang(), b.from, as_of, nf) + ' — ' + date_text(ctx.lang(), b.to, as_of, nf) }),
    h('td', { class: 'num', text: b.currency === null ? '—' : money_text(ctx.lang(), b.net_minor, b.currency, as_of, nf) }),
    h('td', null, btn(ctx.tr('import.rollback'), () => { rollback_ui(ctx, deps, b.batch_id); }, { label: ctx.tr('import.rollback_label', { id: b.batch_id }) }))));
  return h('section', { class: 'card import-batches', 'aria-labelledby': 'import-batches-title' },
    h('h3', { id: 'import-batches-title', text: ctx.tr('import.batches_title') }),
    h('p', { class: 'muted', text: ctx.tr('import.batches_hint') }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: ctx.tr('import.batches_title') }),
      h('thead', null, h('tr', null, th(ctx.tr('import.th_batch')), th(ctx.tr('import.th_count')), th(ctx.tr('import.th_period')), th(ctx.tr('import.th_net')), th(ctx.tr('import.th_decision')))),
      h('tbody', null, rows))));
}

