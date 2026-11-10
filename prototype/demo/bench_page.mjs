// bench_page.mjs — страница bench.html (FP-23, REQ-150, REQ-151): p50 и p95 полного пересчёта в настоящем браузере на наборе G-001 и на синтетических
// наборах около 10³, 2·10³ и 4·10³ событий (горизонт 180 дней), рост времени при удвоении N и текст для вставки в `devices` файла `_ops/bench.json` (поле `device`).
//
// Что страница делает и чего нет. Считает ТЕМ ЖЕ движком (`analyze`, контекст инструментов и ответ Q3), что и приложение; время берёт только из `performance.now()`
// (порт `now`), даты — из часов устройства (`local_date_iso`). Расчёт идёт в главном потоке страницы: блокировка потока и расчёт в Worker здесь не измеряются.
// Единственное обращение к сети — чтение набора G-001 с того же хоста (`../data/g001.json`); строка браузера и сведения об устройстве остаются на экране и в копируемом тексте,
// страница ничего не отправляет. Замер запускает только нажатие кнопки. Цифры — гипотезы-бюджеты (ADR-014), а не обещания продукту; замеры на устройствах этой страницей
// не выполнялись — их делают люди (FP-40).
//
// Устройство страницы: чистые функции и узлы (`h` из dom.mjs: только textContent и узлы). Хранилищ у страницы нет. Кнопка «Запустить» не пересоздаётся на время замера
// (состояние занятости — `aria-disabled`, а не `disabled`), поэтому фокус не теряется; ответы асинхронной работы ищут узлы по идентификатору, а не держат замыкание на отсоединённый узел.
// Расчёт по введённым данным и правилам, не консультация.

import { ENGINE_VERSION } from '../engine/index.mjs';
import { h } from './dom.mjs';
import {
  SYNTH_POINTS, SAMPLE_PLANS, DOUBLING_LIMIT, BUDGET, make_bench_ws, make_sampler, stat_of, doubling_check, build_device_report, timer_resolution_ms, within_budget,
} from './bench_model.mjs';
import {
  make_tr, tr as probe_tr, device_info, device_card, nav_links, copy_card, lang_of, local_date_iso, yield_to_ui, bind_lang_buttons, mark_lang, ms_text,
} from './probe_kit.mjs';
import catalog from './i18n/benchpg.mjs';

const tr = make_tr(catalog);

/** Префикс идентификаторов шапки страницы (`bn-title-bar`, `bn-lang-ru`, `bn-lang-en`). */
export const PREFIX = 'bn';
const IDS = Object.freeze({ plan: 'bn-plan', run: 'bn-run', stop: 'bn-stop', status: 'bn-status', results: 'bn-results' });
const COPY_IDS = Object.freeze({ out: 'bn-out', btn: 'bn-copy', status: 'bn-copy-status' });

/**
 * Прочитать набор G-001 с того же хоста. Порт `fetcher` подменяется в тестах; по умолчанию — настоящий сетевой вызов страницы (единственный в этом модуле).
 * @param {(url: URL) => Promise<{ok: boolean, json: () => Promise<any>}>} [fetcher]
 * @param {string} [base] адрес модуля (для разбора относительного пути)
 */
export async function load_g001(fetcher = (u) => fetch(u), base = import.meta.url) {
  const res = await fetcher(new URL('../data/g001.json', base));
  if (!res.ok) throw new Error('g001_http');
  return res.json();
}

/** Порты страницы: окно, часы (`performance.now()`), дата, чтение G-001, уступка интерфейсу. */
export function make_ports(env = globalThis) {
  return {
    env,
    doc: env.document,
    now: () => env.performance.now(),
    clock: () => new Date(),
    load_g001: () => load_g001(),
    yield_ui: () => yield_to_ui(),
  };
}

/** Состояние страницы. */
export function make_page(lang, ports) {
  return {
    lang, ports, plans: SAMPLE_PLANS, plan: 'full', busy: false, stop: false, // plans — порт: тесты подставляют крошечные планы замера
    status: { key: 'benchpg.status_idle', params: {} },
    report: null, info: device_info(ports.env), date: local_date_iso(ports.clock),
  };
}

function set_status(page, key, params = {}) {
  page.status = { key, params };
  const node = page.ports.doc.getElementById(IDS.status);
  if (node !== null) node.textContent = tr(page.lang, key, params);
}

function mark_busy(page, busy) {
  const doc = page.ports.doc;
  doc.getElementById(IDS.run)?.setAttribute('aria-disabled', String(busy));
  doc.getElementById(IDS.stop)?.setAttribute('aria-disabled', String(!busy));
}

/** Текст для копирования: JSON записи устройства (`runway-bench-device/1`). */
export function report_text(page) {
  return page.report === null ? '' : JSON.stringify(page.report, null, 2);
}

/**
 * Замер. Исключений наружу нет: ошибка шага оставляет неполный результат и пометку. Повторный запуск во время замера отвергается.
 * @param {ReturnType<typeof make_page>} page
 * @returns {Promise<object|null>} запись устройства или `null`
 */
export async function run_bench(page) {
  if (page.busy) { set_status(page, 'benchpg.status_busy'); return null; }
  page.busy = true;
  page.stop = false;
  mark_busy(page, true);
  const { ports } = page;
  const notes = [];
  const sets = [];
  const plan = page.plans[page.plan] ?? SAMPLE_PLANS.full;
  try {
    page.date = local_date_iso(ports.clock);
    page.info = device_info(ports.env);
    const timer_ms = timer_resolution_ms(ports.now);
    const jobs = [
      { id: 'g001', get_ws: () => ports.load_g001(), optional: true },
      ...SYNTH_POINTS.map((p) => ({ id: p.id, get_ws: async () => make_bench_ws(p.copies), optional: false })),
    ];
    const total = jobs.length * plan.samples * plan.rounds;
    let done = 0;
    for (const job of jobs) {
      if (page.stop) break;
      let sampler = null;
      try {
        sampler = make_sampler(await job.get_ws(), ports.now);
      } catch (e) {
        if (!job.optional) throw e;
        notes.push('g001_unavailable');
        done += plan.samples * plan.rounds;
        continue;
      }
      for (let i = 0; i < plan.warmup && !page.stop; i++) { sampler.warm(1); await ports.yield_ui(); }
      const a_ms = [];
      const q_ms = [];
      for (let r = 0; r < plan.rounds && !page.stop; r++) {
        for (let i = 0; i < plan.samples; i++) { const x = sampler.sample(); a_ms.push(x.analyze_ms); q_ms.push(x.q3_ms); done += 1; }
        set_status(page, 'benchpg.status_running', { set: tr(page.lang, 'benchpg.set_' + job.id), done, all: total });
        await ports.yield_ui();
      }
      if (a_ms.length > 0) sets.push({ id: job.id, events: sampler.events, n: a_ms.length, analyze: stat_of(a_ms), recompute_q3: stat_of(q_ms) });
    }
    if (page.stop) notes.push('stopped');
    const synth = sets.filter((s) => s.id !== 'g001');
    const doubling = synth.length >= 2 ? doubling_check(synth.map((s) => ({ id: s.id, events: s.events, ms: s.analyze.p50_ms }))) : null;
    const { user_agent, ...env } = page.info;
    page.report = build_device_report({
      date: page.date, device: user_agent ?? '', env, engine_version: ENGINE_VERSION, timer_ms,
      sets, n: plan.samples * plan.rounds, doubling, notes,
    });
    set_status(page, page.stop ? 'benchpg.status_stopped' : 'benchpg.status_done', { sets: sets.length, n: plan.samples * plan.rounds });
  } catch {
    notes.push('error');
    const { user_agent, ...env } = page.info;
    page.report = build_device_report({ date: page.date, device: user_agent ?? '', env, engine_version: ENGINE_VERSION, timer_ms: null, sets, n: plan.samples * plan.rounds, doubling: null, notes });
    set_status(page, 'benchpg.status_error');
  } finally {
    page.busy = false;
    mark_busy(page, false);
  }
  render_results(page);
  return page.report;
}

// ── показ ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function sets_card(page) {
  const lang = page.lang;
  const r = page.report;
  const head = ['benchpg.th_set', 'benchpg.th_events', 'benchpg.th_n', 'benchpg.th_an_p50', 'benchpg.th_an_p95', 'benchpg.th_q3_p50', 'benchpg.th_q3_p95'];
  const labels = [tr(lang, head[0]), tr(lang, head[1]), tr(lang, head[2]), tr(lang, head[3]), tr(lang, head[4]), tr(lang, head[5]), tr(lang, head[6])];
  return h('section', { class: 'card', 'aria-labelledby': 'bn-sets-title' },
    h('h3', { id: 'bn-sets-title', text: tr(lang, 'benchpg.s_sets') }),
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': tr(lang, 'benchpg.s_sets') },
      h('table', { class: 'tbl' },
        h('caption', { class: 'sr-only', text: tr(lang, 'benchpg.s_sets') }),
        h('thead', null, h('tr', null, labels.map((c) => h('th', { scope: 'col', text: c })))),
        h('tbody', null, r.sets.map((s) => h('tr', null,
          h('th', { scope: 'row', text: tr(lang, 'benchpg.set_' + s.id) }),
          h('td', { text: String(s.events) }), h('td', { text: String(s.n) }),
          h('td', { text: ms_text(lang, s.analyze.p50_ms) }), h('td', { text: ms_text(lang, s.analyze.p95_ms) }),
          h('td', { text: ms_text(lang, s.recompute_q3.p50_ms) }), h('td', { text: ms_text(lang, s.recompute_q3.p95_ms) })))))));
}

function doubling_card(page) {
  const lang = page.lang;
  const d = page.report.doubling;
  const body = d === null
    ? [h('p', { class: 'muted', text: tr(lang, 'benchpg.doubling_none') })]
    : [
      h('p', { class: 'muted', text: tr(lang, 'benchpg.doubling_lead', { limit: String(DOUBLING_LIMIT).replace('.', lang === 'ru' ? ',' : '.') }) }),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': tr(lang, 'benchpg.s_doubling') },
        h('table', { class: 'tbl' },
          h('caption', { class: 'sr-only', text: tr(lang, 'benchpg.s_doubling') }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: tr(lang, 'benchpg.th_step') }), h('th', { scope: 'col', text: tr(lang, 'benchpg.th_n_ratio') }), h('th', { scope: 'col', text: tr(lang, 'benchpg.th_t_ratio') }), h('th', { scope: 'col', text: tr(lang, 'benchpg.th_ok') }))),
          h('tbody', null, d.steps.map((s) => h('tr', null,
            h('th', { scope: 'row', text: tr(lang, 'benchpg.set_' + s.from) + ' → ' + tr(lang, 'benchpg.set_' + s.to) }),
            h('td', { text: ms_text(lang, s.n_ratio) }), h('td', { text: ms_text(lang, s.t_ratio) }),
            h('td', { text: probe_tr(lang, s.ok ? 'probe.yes' : 'probe.no') }))))))];
  return h('section', { class: 'card', 'aria-labelledby': 'bn-dbl-title' }, h('h3', { id: 'bn-dbl-title', text: tr(lang, 'benchpg.s_doubling') }), ...body);
}

function notes_card(page) {
  const lang = page.lang;
  const r = page.report;
  const w = within_budget(r.sets);
  const lines = [
    r.timer_resolution_ms === null ? tr(lang, 'benchpg.note_timer_unknown') : tr(lang, 'benchpg.note_timer', { ms: ms_text(lang, r.timer_resolution_ms) }),
    tr(lang, 'benchpg.note_budget', { limit: BUDGET.recompute_p95_ms }),
    w === null ? tr(lang, 'benchpg.within_none') : tr(lang, w ? 'benchpg.within_yes' : 'benchpg.within_no'),
    tr(lang, 'benchpg.note_thread'),
    tr(lang, 'benchpg.note_hyp'),
    ...r.notes.map((code) => tr(lang, 'benchpg.nc_' + code)),
  ];
  return h('section', { class: 'card', 'aria-labelledby': 'bn-notes-title' },
    h('h3', { id: 'bn-notes-title', text: tr(lang, 'benchpg.s_notes') }),
    h('ul', null, lines.map((t) => h('li', { text: t }))),
    h('p', { class: 'muted', text: tr(lang, 'benchpg.copy_how') }));
}

/** Перерисовать только блок результатов (кнопка запуска остаётся тем же узлом). */
export function render_results(page) {
  const box = page.ports.doc.getElementById(IDS.results);
  if (box === null) return;
  if (page.report === null) { box.replaceChildren(); return; }
  box.replaceChildren(
    device_card(page.lang, page.info, page.report.date, { title: 'bn-dev-title' }),
    sets_card(page), doubling_card(page), notes_card(page),
    copy_card(page.lang, COPY_IDS, () => report_text(page), { env: page.ports.env, doc: page.ports.doc }));
}

/** Перерисовать страницу целиком (при смене языка и первой отрисовке). */
export function render_page(page) {
  const doc = page.ports.doc;
  const lang = page.lang;
  const select = h('select', { id: IDS.plan, 'aria-describedby': 'bn-plan-hint', onchange: (ev) => { const v = ev?.target?.value; if (typeof v === 'string' && Object.hasOwn(page.plans, v)) page.plan = v; } },
    h('option', { value: 'quick', selected: page.plan === 'quick' ? true : null, text: tr(lang, 'benchpg.plan_quick', { n: SAMPLE_PLANS.quick.samples * SAMPLE_PLANS.quick.rounds }) }),
    h('option', { value: 'full', selected: page.plan === 'full' ? true : null, text: tr(lang, 'benchpg.plan_full', { n: SAMPLE_PLANS.full.samples * SAMPLE_PLANS.full.rounds }) }));
  const controls = h('section', { class: 'card', 'aria-labelledby': 'bn-run-title' },
    h('h3', { id: 'bn-run-title', text: tr(lang, 'benchpg.s_run') }),
    h('p', { text: tr(lang, 'benchpg.lead') }),
    h('div', { class: 'field' }, h('label', { for: IDS.plan, text: tr(lang, 'benchpg.f_plan') }), select, h('p', { id: 'bn-plan-hint', class: 'muted', text: tr(lang, 'benchpg.h_plan') })),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', id: IDS.run, onclick: () => { if (page.busy) { set_status(page, 'benchpg.status_busy'); return; } void run_bench(page); }, text: tr(lang, 'benchpg.btn_run') }),
      h('button', { type: 'button', class: 'btn', id: IDS.stop, 'aria-disabled': 'true', onclick: () => { if (page.busy) page.stop = true; }, text: tr(lang, 'benchpg.btn_stop') })),
    h('p', { id: IDS.status, class: 'muted', role: 'status', 'aria-live': 'polite', text: tr(lang, page.status.key, page.status.params) }));
  doc.getElementById('main').replaceChildren(
    nav_links(lang, 'bench'),
    h('h2', { id: 'view-title', tabindex: '-1', text: tr(lang, 'benchpg.title') }),
    controls,
    h('div', { id: IDS.results }),
    h('p', { class: 'muted', text: probe_tr(lang, 'probe.disclaimer') }));
  mark_lang(PREFIX, lang, doc);
  doc.title = tr(lang, 'benchpg.doc_title');
  mark_busy(page, page.busy);
  render_results(page);
}

/** Запуск страницы (вызывается при загрузке bench.html). */
export function boot_bench(env = globalThis) {
  const ports = make_ports(env);
  const page = make_page(lang_of(env), ports);
  bind_lang_buttons(PREFIX, (l) => { page.lang = l; render_page(page); }, ports.doc);
  render_page(page);
  return page;
}

if (typeof document !== 'undefined' && document.getElementById('bn-title-bar') !== null) boot_bench();
