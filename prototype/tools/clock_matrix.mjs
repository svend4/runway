#!/usr/bin/env node
// clock_matrix.mjs — FP-50 (RISK-22): матрица часов и поясов. Тестовые файлы запускаются ПО ОДНОМУ (один процесс node за раз) под пятью профилями:
//   base           — без сдвига: предзагрузка подключена, но ничего не меняет (контроль: тот же механизм, нулевой сдвиг);
//   shift_far      — сдвиг часов +400 суток;
//   shift_past     — местное время 2026-10-23 12:00 в поясе машины (раньше дат, введённых в тестах: 2026-10-25 и позже);
//   midnight_east  — пояс Pacific/Kiritimati (UTC+14), местное время 00:30: дата по UTC на сутки раньше местной;
//   midnight_west  — пояс Pacific/Pago_Pago (UTC−11), местное время 23:30: дата по UTC на сутки позже местной.
// Механизм: NODE_OPTIONS=--import=<URL tools/clock_shift_preload.mjs> и переменные RUNWAY_CLOCK_* (см. предзагрузку); пояс задаётся и через TZ
// в окружении дочернего процесса, и предзагрузкой (на Windows переменная TZ при старте работает, но путь через process.env.TZ проверен отдельно).
// Перед каждым профилем — проверка (probe): предзагрузка подключена, сдвиг и пояс применились. Пояс не применился — профиль пропускается с объяснением;
// сдвиг или подмена Date не применились — матрица не запускается (код 2).
//   node tools/clock_matrix.mjs [--fast] [--files a,b] [--profiles p1,p2] [--list] [--timeout 240]
//                               [--resume [--rerun-failed | --force]] [--summary-only] [--no-write]
// --fast — тот же состав файлов, что `run_all_tests.mjs --fast` (без HEAVY_FILES). --files — подстроки путей через запятую.
// --resume — продолжить прерванный профиль (файлы, уже записанные в results, не запускаются); --rerun-failed — красные файлы запустить ещё раз один раз;
// --force — запустить выбранные файлы заново в любом случае (после правки кода или разбора). Повтор записывается в поле `attempts` (все прогоны файла; `retried` — первый прогон, статус и
// `red`): таймаут при первом прогоне и зелёный при повторе — не то же, что датозависимый сбой. Строки файлов вне выборки при --resume сохраняются.
// Результаты: ../_ops/impl/run/clock-matrix-<профиль>.json (и .txt); свод: ../_ops/clock-matrix.json (`--summary-only` пересобирает свод без запусков).
// Разбор красных — tools/clock_matrix_known.json: записи с обоснованием на каждый файл и вердикты по профилям. Инструмент вне engine/: часы допустимы.
// Расчёт по введённым данным и правилам, не консультация.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HEAVY_FILES, discover, is_red, run_file, summary_text } from './run_all_tests.mjs';
import { CLOCK_VARS, clock_shift_ms, zone_offset_ms } from './clock_shift_preload.mjs';

export const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRELOAD_FILE = path.join(PROTO, 'tools', 'clock_shift_preload.mjs');
export const KNOWN_FILE = path.join(PROTO, 'tools', 'clock_matrix_known.json');
export const RUN_DIR = path.join(PROTO, '..', '_ops', 'impl', 'run');
export const SUMMARY_FILE = path.join(PROTO, '..', '_ops', 'clock-matrix.json');
const DAY_MS = 86400000;

/** Порядок профилей: base первым — от него считаются «красные сверх base». */
export const PROFILE_ORDER = Object.freeze(['base', 'shift_far', 'shift_past', 'midnight_east', 'midnight_west']);

/** Профили: заголовок (для людей) и переменные. Пояс у midnight-профилей — и TZ, и RUNWAY_CLOCK_TZ. */
export const PROFILES = Object.freeze({
  base: { title: 'без сдвига: часы и пояс машины (предзагрузка подключена, ничего не меняет)', env: {} },
  shift_far: { title: 'сдвиг часов +400 суток (RUNWAY_CLOCK_SHIFT_MS)', env: { RUNWAY_CLOCK_SHIFT_MS: String(400 * DAY_MS) } },
  shift_past: { title: 'местное время 2026-10-23 12:00 в поясе машины (RUNWAY_CLOCK_LOCAL)', env: { RUNWAY_CLOCK_LOCAL: '2026-10-23 12:00' } },
  midnight_east: { title: 'пояс Pacific/Kiritimati (UTC+14), местное время 00:30 сегодняшней местной даты пояса', env: { RUNWAY_CLOCK_TZ: 'Pacific/Kiritimati', RUNWAY_CLOCK_LOCAL: '00:30' } },
  midnight_west: { title: 'пояс Pacific/Pago_Pago (UTC−11), местное время 23:30 сегодняшней местной даты пояса', env: { RUNWAY_CLOCK_TZ: 'Pacific/Pago_Pago', RUNWAY_CLOCK_LOCAL: '23:30' } },
});

const has_value = (v) => v !== undefined && v !== '';

/**
 * Переменные окружения профиля для run_file (`{...process.env, ...env}`): переменные часов, которых нет в профиле, — undefined (удаляются из окружения);
 * пояс — TZ; NODE_OPTIONS — прежние опции плюс предзагрузка.
 */
export function profile_env(name, base_env = process.env) {
  const p = PROFILES[name];
  if (p === undefined) throw new RangeError(`неизвестный профиль «${name}»: есть ${PROFILE_ORDER.join(', ')}`);
  const env = {};
  for (const k of CLOCK_VARS) env[k] = undefined;
  Object.assign(env, p.env);
  if (has_value(p.env.RUNWAY_CLOCK_TZ)) env.TZ = p.env.RUNWAY_CLOCK_TZ;
  env.NODE_OPTIONS = [base_env.NODE_OPTIONS, '--import=' + pathToFileURL(PRELOAD_FILE).href].filter(has_value).join(' ');
  return env;
}

/** Окружение, которое получает процесс профиля (без undefined): то же слияние, что делает run_file. */
export function spawn_env(name, base_env = process.env) {
  const merged = { ...base_env, ...profile_env(name, base_env) };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
}

const PROBE_SRC = [
  'const d = new Date();',
  'console.log(JSON.stringify({ now: Date.now(), real: performance.timeOrigin + performance.now(), off: d.getTimezoneOffset(),',
  '  native: /\\[native code\\]/.test(Function.prototype.toString.call(Date)), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }));',
].join('\n');

/**
 * Проверка профиля до прогона: процесс запускается с предзагрузкой; Date подменён ровно в шаблонах профиля (base — нет);
 * пояс и смещение совпадают с ожидаемыми на этот момент; сдвиг (now − реальное время) совпадает с ожидаемым в пределах 5 с.
 * `fatal` — сбой предзагрузки или запуска (матрица не запускается); `zone_skip` — пояс не применился (профиль пропускается с объяснением).
 */
export function probe_profile(name, base_env = process.env) {
  const p = PROFILES[name];
  const r = spawnSync(process.execPath, ['-e', PROBE_SRC], { env: spawn_env(name, base_env), encoding: 'utf8', timeout: 60000 });
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  let got = null;
  try { got = JSON.parse(last); } catch { got = null; }
  if (r.status !== 0 || got === null) {
    const why = ((r.stderr ?? '') + (r.error ? r.error.message : '')).trim().split('\n').slice(0, 3).join(' | ');
    return { ok: false, fatal: true, zone_skip: false, why: 'проверка не запустилась: ' + (why || 'нет вывода') };
  }
  const system_zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = has_value(p.env.RUNWAY_CLOCK_TZ) ? p.env.RUNWAY_CLOCK_TZ : system_zone;
  const real = performance.timeOrigin + performance.now(); // реальные часы, не подменённый Date: проверка верна и внутри процесса со сдвигом
  const want_shift = clock_shift_ms(p.env, real, system_zone);
  const want_off = -zone_offset_ms(zone, real + want_shift) / 60000; // смещение — в момент, который показывает процесс (после сдвига)
  const shift = got.now - got.real;
  const zone_bad = [];
  if (got.tz !== zone) zone_bad.push(`пояс: ожидался ${zone}, получен ${got.tz}`);
  if (got.off !== want_off) zone_bad.push(`смещение: ожидалось ${want_off} мин, получено ${got.off} мин`);
  const fatal_bad = [];
  if (got.native !== (name === 'base')) fatal_bad.push(name === 'base' ? 'в base Date подменён' : 'подмена Date не применилась');
  if (Math.abs(shift - want_shift) > 5000) fatal_bad.push(`сдвиг часов: ожидался ${Math.round(want_shift)} мс, получен ${Math.round(shift)} мс`);
  const ok = zone_bad.length === 0 && fatal_bad.length === 0;
  return {
    ok, fatal: fatal_bad.length > 0, zone_skip: fatal_bad.length === 0 && zone_bad.length > 0, zone, system_zone,
    shift_ms: Math.round(shift), want_shift_ms: Math.round(want_shift), off_min: got.off, want_off_min: want_off, native: got.native,
    why: [...fatal_bad, ...zone_bad].join('; ') || null,
  };
}

/** Записи разбора красных: {file, profiles: [...] | '*', reason}; вердикты по профилям. Нет файла — пустой разбор. */
export function load_known(file = KNOWN_FILE) {
  if (!fs.existsSync(file)) return { entries: [], verdicts: {} };
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { entries: Array.isArray(j.entries) ? j.entries : [], verdicts: j.verdicts ?? {} };
}

/** Запись разбора, которая объясняет красный файл в профиле (или `null`). */
export function known_for(known, file, profile) {
  return known.entries.find((e) => e.file === file && (e.profiles === '*' || (Array.isArray(e.profiles) && e.profiles.includes(profile)))) ?? null;
}

/** Ошибки в разборе: без обоснования, неизвестный профиль, файла нет, дубли (пустой список — всё верно). */
export function check_known(known, root = PROTO) {
  const problems = [];
  const seen = new Set();
  for (const e of known.entries) {
    const key = `${e.file}|${JSON.stringify(e.profiles)}`;
    if (seen.has(key)) problems.push(`дубль записи: ${e.file}`);
    seen.add(key);
    if (typeof e.file !== 'string' || !fs.existsSync(path.join(root, e.file))) problems.push(`нет файла: ${e.file}`);
    if (!(e.profiles === '*' || (Array.isArray(e.profiles) && e.profiles.length > 0 && e.profiles.every((p) => PROFILE_ORDER.includes(p))))) problems.push(`неизвестный профиль у ${e.file}`);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 40) problems.push(`нет обоснования (от 40 знаков) у ${e.file}`);
  }
  return problems;
}

function profile_file(name) { return path.join(RUN_DIR, `clock-matrix-${name}.json`); }

/** Результаты профиля с диска (или `null`). */
export function read_profile(name) {
  const f = profile_file(name);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/**
 * Свод: по каждому профилю — число файлов, красные, таймауты, повторы, «красные сверх base» с разбором (записи известных / не разобрано) и вердикт.
 * `results` — объект профиль → результат (`rows`, `finished`, `files_total`, `env`, `probe`, `skipped`, `mode`, `title`).
 */
export function build_summary({ results, known, now_iso = new Date().toISOString(), node = process.version, machine_zone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
  const base = results.base;
  const base_red = new Set(base === undefined ? [] : base.rows.filter(is_red).map((r) => r.file));
  const profiles = {};
  for (const name of PROFILE_ORDER) {
    const res = results[name];
    if (res === undefined) continue;
    const rows = res.rows ?? [];
    const red = rows.filter(is_red);
    const not_in_base = base === undefined ? null : red.filter((r) => !base_red.has(r.file));
    const known_here = (not_in_base ?? []).map((r) => ({ file: r.file, reason: known_for(known, r.file, name)?.reason ?? null })).filter((x) => x.reason !== null);
    const unexplained = (not_in_base ?? []).filter((r) => known_for(known, r.file, name) === null).map((r) => r.file);
    const retried_ok = rows.filter((r) => r.retried?.red === true && !is_red(r)).map((r) => ({ file: r.file, first: r.retried }));
    // вердикт вычисляется по данным и виден всегда; ручной комментарий из tools/clock_matrix_known.json выводится отдельным полем `note` (FP-50)
    const verdict = res.skipped ? 'пропущен: ' + res.skipped
      : name === 'base' ? (red.length === 0 ? 'красных нет' : `красных ${red.length} (эталон, не сравнивается)`)
      : not_in_base === null ? 'нет базового прогона'
      : unexplained.length > 0 ? `НЕ РАЗОБРАНО: ${unexplained.length}`
      : not_in_base.length === 0 ? 'красных сверх base нет' : 'все красные сверх base объяснены записями разбора';
    profiles[name] = {
      title: PROFILES[name].title,
      env: Object.fromEntries(Object.entries(PROFILES[name].env)),
      mode: res.mode ?? null,
      skipped: res.skipped ?? null,
      probe: res.probe ?? null,
      files: res.files_total ?? rows.length,
      done: rows.length,
      finished: res.finished === true,
      tests: rows.reduce((a, r) => a + (r.tests ?? 0), 0),
      pass: rows.reduce((a, r) => a + (r.pass ?? 0), 0),
      fail: rows.reduce((a, r) => a + (r.fail ?? 0), 0),
      red: red.map((r) => r.file),
      timed_out: rows.filter((r) => r.timed_out).map((r) => r.file),
      timed_out_first: rows.filter((r) => r.retried?.timed_out === true).map((r) => r.file),
      retried_ok,
      red_not_in_base: not_in_base,
      known_explained: known_here,
      unexplained,
      details: Object.fromEntries((not_in_base ?? []).map((r) => [r.file, (r.tail ?? []).slice(0, 4)])),
      verdict,
      note: known.verdicts?.[name] ?? null,
    };
  }
  const unexplained_total = Object.values(profiles).reduce((a, p) => a + p.unexplained.length, 0);
  const base_red_count = base === undefined ? null : base_red.size;
  const at = new Date(now_iso);
  const p2 = (n) => String(n).padStart(2, '0');
  const local_date = `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())}`; // гражданская дата отчёта — местная, не UTC
  return {
    date: local_date, generated: now_iso, node, machine_zone,
    preload: 'prototype/tools/clock_shift_preload.mjs',
    profile_order: PROFILE_ORDER,
    base_red: base_red_count,
    unexplained_total,
    profiles,
    known: known.entries,
  };
}

/** Красные сверх base и не объяснённые — отдельный признак для кода выхода. */
export function summary_ok(summary) {
  return summary.unexplained_total === 0 && summary.base_red === 0;
}

function write_json(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}

/** Сведения одного прогона файла для истории повторов (статус, числа, таймаут, красный ли). */
export function attempt_of(r) {
  return { status: r.status, tests: r.tests, fail: r.fail, timed_out: r.timed_out === true, ms: r.ms, red: is_red(r) };
}

/** История прогонов строки: `attempts`, а у строк прежней версии — первый прогон (`retried`) и последний. */
export function history_of(row) {
  if (Array.isArray(row.attempts)) return row.attempts;
  return row.retried !== undefined ? [row.retried, attempt_of(row)] : [attempt_of(row)];
}

/**
 * Один профиль: проверка, затем файлы по одному; после каждого файла — запись результата (устойчивость к обрыву).
 * `resume` — взять строки прошлого прогона; `rerun_failed` — красные строки запустить ещё раз (один раз); `force` — запустить выбранные файлы заново в любом случае.
 * Строки прошлого прогона для файлов вне выборки сохраняются: частичный прогон (`--files`) не стирает остальной профиль. Повтор записывается в `attempts`
 * (все прогоны файла по порядку); `retried` — первый прогон (статус, числа, `red` — был ли он красным).
 */
export function run_profile({ name, files, timeout_s = 240, resume = false, rerun_failed = false, force = false, base_env = process.env, runner = run_file, log = () => {}, write = true, mode = 'fast', probe = null, prev_state = null }) {
  const p = PROFILES[name];
  const checked = probe ?? probe_profile(name, base_env);
  const started = Date.now();
  const prev = resume ? (prev_state ?? read_profile(name)) : null; // prev_state — состояние прошлого прогона в памяти (повтор без файла на диске)
  const prev_rows = new Map((prev?.rows ?? []).map((r) => [r.file, r]));
  const wanted = new Set(files);
  const kept_outside = [...prev_rows.values()].filter((r) => !wanted.has(r.file));
  const files_total = Math.max(prev?.files_total ?? 0, files.length, prev_rows.size);
  const rows = [];
  const ordered = () => [...rows, ...kept_outside].sort((a, b) => a.file.localeCompare(b.file));
  const state = (finished) => ({ profile: name, title: p.title, env: p.env, mode, probe: checked, files_total, finished, rows: ordered(), started_ms: started });
  const save = (finished) => {
    if (!write) return;
    const current = ordered();
    write_json(profile_file(name), state(finished));
    fs.writeFileSync(profile_file(name).replace(/\.json$/, '.txt'), summary_text(current, { profile: name, of: files_total, finished, started_ms: started, now_ms: Date.now() }));
  };
  if (checked.fatal || (!checked.ok && !checked.zone_skip)) return { ...state(true), skipped: null, fatal: checked.why };
  if (checked.zone_skip) {
    const res = { ...state(true), skipped: 'пояс не применился на этой машине: ' + checked.why };
    save(true);
    log(`ПРОПУЩЕН ${name}: ${res.skipped}`);
    return res;
  }
  for (const f of files) {
    const before = prev_rows.get(f);
    const again = before !== undefined && (force || (rerun_failed && is_red(before) && before.retried === undefined));
    if (before !== undefined && !again) { rows.push(before); continue; }
    const fresh = runner(PROTO, f, { timeout_s, env: profile_env(name, base_env) });
    if (before !== undefined) { fresh.attempts = [...history_of(before), attempt_of(fresh)]; fresh.retried = fresh.attempts[0]; } // история не теряется: первый прогон — в retried и в attempts
    rows.push(fresh);
    log(`${name.padEnd(13)} ${is_red(fresh) ? 'КРАСНЫЙ' : 'ok     '} ${f}: ${fresh.tests} тестов, ${fresh.ms} мс${fresh.timed_out ? ' (таймаут)' : ''}${fresh.retried ? ' [повтор]' : ''}`);
    save(false);
  }
  save(true);
  return { ...state(true), skipped: null };
}

/** Ошибка использования: печатается строкой, код выхода 2 (а не необработанное исключение). */
export class UsageError extends Error {}

/** Значение флага; флаг без значения (последний или за ним другой флаг) — `UsageError` (FP-50, разбор матрицы). */
function arg_of(argv, name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name}: нужно значение`);
  return v;
}

function read_all_results() {
  const out = {};
  for (const name of PROFILE_ORDER) { const r = read_profile(name); if (r !== null) out[name] = r; }
  return out;
}

function print_summary(summary) {
  const lines = [`свод ${summary.date}: базовых красных ${summary.base_red ?? 'нет базы'}, не разобрано сверх base ${summary.unexplained_total}`];
  for (const [name, p] of Object.entries(summary.profiles)) {
    lines.push(`  ${name.padEnd(13)} файлов ${p.done}/${p.files}${p.finished ? '' : ' (не завершён)'}${p.skipped ? ' ПРОПУЩЕН' : ''}; красных ${p.red.length}; сверх base ${p.red_not_in_base === null ? '—' : p.red_not_in_base.length}; объяснено ${p.known_explained.length}; таймаутов ${p.timed_out.length}; повторы зелёные ${p.retried_ok.length}; ${p.verdict}${p.note ? ' | разбор: ' + p.note : ''}`);
  }
  return lines.join('\n');
}

/** Командная строка; возвращает код выхода: 0 — свод без красных сверх base и без красных в base; 1 — есть; 2 — неверный запуск или сбой предзагрузки. */
export function main(argv) {
  try { return run_main(argv); } catch (e) { if (e instanceof UsageError) { console.error(e.message); return 2; } throw e; }
}

function run_main(argv) {
  const leaked =CLOCK_VARS.filter((k) => has_value(process.env[k]));
  if (leaked.length > 0) { console.error(`переменные ${leaked.join(', ')} заданы в окружении: матрица задаёт их сама; снимите их и запустите снова`); return 2; }
  const known = load_known();
  const problems = check_known(known);
  if (problems.length > 0) { console.error('разбор (tools/clock_matrix_known.json) с ошибками:\n  ' + problems.join('\n  ')); return 2; }
  const fast = argv.includes('--fast');
  const timeout_s = Number(arg_of(argv, '--timeout', 240));
  if (!Number.isFinite(timeout_s) || timeout_s < 1) { console.error('--timeout — число секунд ≥ 1'); return 2; }
  let selected = PROFILE_ORDER;
  const want_arg = arg_of(argv, '--profiles', null);
  if (want_arg !== null) {
    const want = want_arg.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = want.filter((p) => !PROFILE_ORDER.includes(p));
    if (bad.length > 0) { console.error('неизвестные профили: ' + bad.join(', ') + '; есть: ' + PROFILE_ORDER.join(', ')); return 2; }
    selected = PROFILE_ORDER.filter((p) => want.includes(p));
  }
  let files = discover(PROTO);
  if (fast) files = files.filter((f) => !HEAVY_FILES.includes(f));
  const only = arg_of(argv, '--files', null);
  if (only !== null) { const parts = only.split(',').map((s) => s.trim()).filter(Boolean); files = files.filter((f) => parts.some((p) => f.includes(p))); }
  if (argv.includes('--list')) {
    for (const name of selected) console.log(`${name}\t${PROFILES[name].title}\t${JSON.stringify(PROFILES[name].env)}`);
    for (const f of files) console.log(f + (HEAVY_FILES.includes(f) ? '\t(тяжёлый)' : ''));
    console.log(`файлов: ${files.length}`);
    return 0;
  }
  const write = !argv.includes('--no-write');
  if (argv.includes('--summary-only')) {
    const summary = build_summary({ results: read_all_results(), known });
    if (write) write_json(SUMMARY_FILE, summary);
    console.log(print_summary(summary));
    return summary_ok(summary) ? 0 : 1;
  }
  if (files.length === 0) { console.error('нет файлов под выбранные фильтры'); return 2; }
  // Сначала проверка всех выбранных профилей: сбой предзагрузки — до первого запуска тестов.
  const probes = {};
  for (const name of selected) probes[name] = probe_profile(name);
  const fatal = Object.entries(probes).filter(([, p]) => p.fatal || (!p.ok && !p.zone_skip));
  if (fatal.length > 0) { for (const [n, p] of fatal) console.error(`${n}: предзагрузка часов не работает (${p.why}); матрица не запущена`); return 2; }
  console.log(`матрица часов: профили ${selected.join(', ')}; ${files.length} файлов${fast ? ' (профиль --fast)' : ''}; один процесс node за раз; Node ${process.version}`);
  const resume = argv.includes('--resume');
  const rerun_failed = argv.includes('--rerun-failed');
  const force = argv.includes('--force');
  for (const name of selected) {
    const res = run_profile({ name, files, timeout_s, resume, rerun_failed, force, log: (s) => console.log(s), write, mode: fast ? 'fast' : 'all', probe: probes[name] });
    console.log(res.skipped ? `профиль ${name}: пропущен — ${res.skipped}` : `профиль ${name}: ${res.rows.length} из ${res.files_total}, красных ${res.rows.filter(is_red).length}`);
  }
  const summary = build_summary({ results: read_all_results(), known });
  if (write) write_json(SUMMARY_FILE, summary);
  console.log(print_summary(summary));
  return summary_ok(summary) ? 0 : 1;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) process.exitCode = main(process.argv.slice(2));
