#!/usr/bin/env node
// cli.mjs — командная строка прототипа Runway (режим A0, без LLM): команда → инструмент движка → ответ шаблоном с evidence.
// Это ГРАНИЦА движка: здесь допустимы node:fs и process (в engine/ — нет). Расчёт по введённым данным, не консультация.
//
// Использование:
//   node cli.mjs <файл.json> <команда> [аргументы…] [--locale ru|en] [--as-of YYYY-MM-DD] [--mode plan|worse] [--json] [--t1]
// Пример (G-001):
//   node cli.mjs data/g001.json check-purchase 2026-10-12 30000 EUR
// Команды (суммы — целые minor units: 30000 = 300,00 €):
//   check-purchase <дата> <сумма> <ВАЛЮТА> [--buffer N]   можно ли купить: вердикт, минимум после покупки, ранняя дата
//   projection <до> [от]                                   остаток, минимум, «можно потратить до даты»
//   max-amount <дата>                                      максимальная разовая покупка на дату
//   earliest <сумма> <ВАЛЮТА> [не_раньше]                  самая ранняя дата, с которой сумма держится в буфере
//   waves <от> <до>                                        волны платежей и их метрики
//   explain [top_k]                                        почему узкая точка именно там
//   scenario delay <event_ref> <дней> | purchase <дата> <сумма> <ВАЛЮТА>
//   tax [дата]                                             налоговый конверт (расчёт по введённым правилам, не консультация)
//   changed <дата|c_hex>                                   что изменилось (нужен журнал: рабочая область с полем `journal`)
//   propose skip <ref> | move <ref> <дата> | add <дата> <сумма> <ВАЛЮТА>   черновик изменений (T1, нужен --t1; ничего не записывает)
// Ключи: --json — печатает Result целиком; --t1 — включает уровень T1; --locale — язык ответа (по умолчанию из рабочей области, иначе ru).
// Код выхода: 0 — ответ получен; 1 — ошибка инструмента (текст без значений аргументов); 2 — неверный запуск.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { make_tool_ctx } from './engine/tools.mjs';
import { a0_answer, parse_command, render_value, LABELS } from './engine/verifier.mjs';
import { ENGINE_VERSION } from './engine/index.mjs';

const COMMANDS = ['check-purchase', 'projection', 'max-amount', 'earliest', 'waves', 'explain', 'scenario', 'tax', 'changed', 'propose'];

/** Текст справки: шапка этого файла. */
function usage_text() {
  return fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(3).map((l) => l.slice(3)).join('\n') + '\n';
}

/** Вынуть ключи `--имя [значение]` из аргументов. */
function take_flags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--t1' || a === '--help' || a === '-h') flags[a.replace(/^-+/, '')] = true;
    else if (a === '--locale' || a === '--as-of') { flags[a.slice(2)] = argv[i + 1]; i += 1; } else rest.push(a);
  }
  return { flags, rest };
}

/**
 * Выполнить команду в процессе (для тестов и для `main`): возвращает вывод, ничего не печатая.
 * @param {string[]} argv аргументы без `node` и пути скрипта
 * @param {{read_file?: (p: string) => string}} [io] порт чтения файла (по умолчанию `fs.readFileSync`)
 * @returns {{status: 0|1|2, stdout: string, stderr: string}}
 */
export function run_cli(argv, io = {}) {
  const read_file = io.read_file ?? ((p) => fs.readFileSync(p, 'utf8'));
  let out = '';
  let err = '';
  const { flags, rest } = take_flags(argv);
  if (flags.help || flags.h) return { status: 0, stdout: usage_text(), stderr: '' };
  if (rest.length < 2) return { status: 2, stdout: '', stderr: usage_text() };
  const [file, ...words] = rest;
  if (!COMMANDS.includes(words[0])) return { status: 2, stdout: '', stderr: 'Неизвестная команда. Список: ' + COMMANDS.join(', ') + '\n' };
  let ws;
  try {
    ws = JSON.parse(read_file(path.resolve(file)));
  } catch {
    return { status: 2, stdout: '', stderr: 'Не удалось прочитать рабочую область: проверьте путь к файлу и формат JSON.\n' };
  }
  const as_of = flags['as-of'] ?? ws.as_of;
  if (typeof as_of !== 'string') return { status: 2, stdout: '', stderr: 'Укажите дату расчёта: поле as_of в файле или ключ --as-of YYYY-MM-DD.\n' };
  const locale = flags.locale ?? ws.locale ?? 'ru';
  if (locale !== 'ru' && locale !== 'en') return { status: 2, stdout: '', stderr: 'Язык: ru или en.\n' };
  let cmd;
  try {
    cmd = parse_command(words);
  } catch {
    return { status: 2, stdout: '', stderr: 'Неверные аргументы команды: см. node cli.mjs --help.\n' };
  }
  let ctx;
  try {
    ctx = make_tool_ctx(ws, { as_of }, { t1_enabled: flags.t1 === true, locale, journal: Array.isArray(ws.journal) ? ws.journal : null });
  } catch (e) {
    return { status: 2, stdout: '', stderr: `Расчёт не выполнен (${e?.code ?? 'ошибка'}): проверьте данные рабочей области.\n` };
  }
  const r = a0_answer(cmd, ctx, { locale });
  if (!r.ok) {
    out += r.text + '\n';
    out += `[${r.error.code}${r.error.reason === undefined ? '' : ': ' + r.error.reason}]\n`;
    return { status: 1, stdout: out, stderr: err };
  }
  if (flags.json) return { status: 0, stdout: JSON.stringify(r.result, null, 2) + '\n', stderr: '' };
  const res = r.result;
  const ru = locale === 'ru';
  out += r.text + '\n\n';
  out += `[${ru ? 'числа из расчёта' : 'numbers from the calculation'} c_${res.call_id} · ${ru ? 'движок' : 'engine'} ${ENGINE_VERSION} · as_of ${res.as_of} · ${LABELS.modes[locale][res.scope.mode]}${r.verified ? '' : ' · ПРОВЕРКА НЕ ПРОЙДЕНА'}]\n`;
  out += `${ru ? 'Доказательства (evidence)' : 'Evidence'}:\n`;
  for (const e of res.evidence) {
    const raw = e.kind === 'money' ? `${e.v} ${e.cur}` : String(e.v);
    out += `  ${e.id.padEnd(4)} ${e.kind.padEnd(7)} ${render_value(e, locale, res.as_of).padEnd(16)} (${raw})\n`;
  }
  if (r.echo.length > 0) {
    out += `${ru ? 'Из вопроса и параметров' : 'From the question and parameters'}:\n`;
    for (const e of r.echo) out += `  ${e.id.padEnd(16)} ${render_value(e, locale, res.as_of)}\n`;
  }
  if (res.warnings.length > 0) out += `${ru ? 'Предупреждения' : 'Warnings'}: ${res.warnings.map((w) => w.code).join(', ')}\n`;
  out += `inputs_hash: ${res.inputs_hash}\n`;
  return { status: r.verified ? 0 : 1, stdout: out, stderr: err };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = run_cli(process.argv.slice(2));
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  process.exitCode = r.status;
}
