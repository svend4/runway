#!/usr/bin/env node
// hledger_oracle.mjs — независимая сверка экспорта hledger с настоящим `hledger` через Docker (FP-12, REQ-173, TST-44, C-042). ТОЛЬКО скрипт и документ: Docker этим проектом не запускался.
// Что делает: выгружает G-001 тем же путём, что кнопка «Экспорт hledger» (`demo/data_actions.export_hledger_file`), записывает `g001.journal` в каталог `--dir`, печатает команды
// `docker run … hledger … bal assets:bank --forecast=… -e …` и ожидаемые остатки, взятые из ряда `close` движка (режим «по плану»). С ключом `--run` запускает эти команды и сверяет остатки
// (нужен Docker в PATH и образ с hledger). Без `--run` ничего не запускается и ничего не скачивается. Контейнер получает каталог только для чтения и без сети (`--network none`).
//   node tools/hledger_oracle.mjs [--dir <каталог>] [--image <образ>] [--run] [--json]
// Имя образа по умолчанию — пример из публичных образов, НЕ ПРОВЕРЕННЫЙ этим проектом (не подтверждено): проверьте образ и закрепите его по хэшу, прежде чем запускать.
// Инструмент вне engine/: node:* и process допустимы. Расчёт по введённым данным и правилам, не консультация.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Образ по умолчанию: пример, не подтверждён проектом (см. шапку). */
export const DEFAULT_IMAGE = 'dastapov/hledger';
/** Дни проверки (даты — «до» не включительно, как ключ `-e` в hledger) для набора G-001. */
export const CHECK_DAYS = Object.freeze(['2026-11-01', '2026-12-01']);

const demo = (name) => import(pathToFileURL(path.join(PROTO, 'demo', name)).href);
const eng = (name) => import(pathToFileURL(path.join(PROTO, 'engine', name)).href);

/** Остаток на конец дня перед датой `-e` (исключая её) из ряда `close` режима «по плану»: деньги на счетах. */
export function expected_balance(analysis, end_exclusive, dates) {
  const last = dates.parse_date(end_exclusive) - 1;
  const i = last - dates.to_epoch_day(analysis.as_of);
  if (i < 0 || i >= analysis.series.plan.close.length) throw new RangeError('дата вне горизонта расчёта: ' + end_exclusive);
  return analysis.series.plan.close[i];
}

/** Строка вывода hledger (`2055.00 EUR`, `-3,400.00 EUR`, `1 234.50 EUR`) → minor units для валюты с 2 знаками; иначе `null`. */
export function parse_balance_line(line) {
  const m = /(-?)\s*([0-9][0-9\s,.]*?)\s*EUR\b/.exec(String(line).replace(/[   ]/g, ' '));
  if (m === null) return null;
  const digits = m[2].replace(/[\s,]/g, '');
  const mm = /^(\d+)\.(\d{2})$/.exec(digits);
  if (mm === null) return null;
  const v = Number(mm[1]) * 100 + Number(mm[2]);
  return m[1] === '-' ? -v : v;
}

/**
 * Команды `docker run` для набора проверок.
 * @param {{dir: string, image?: string, account?: string, as_of: string, horizon_end: string, days?: string[]}} o `account` — имя счёта в журнале (по умолчанию `assets:bank`)
 * @returns {{end: string, args: string[], text: string}[]} `args` — для `spawnSync('docker', args)`; `text` — для печати
 */
export function build_commands(o) {
  const image = o.image ?? DEFAULT_IMAGE;
  const account = o.account ?? 'assets:bank';
  const quote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : '"' + s.replace(/"/g, '\\"') + '"');
  return (o.days ?? CHECK_DAYS).map((end) => {
    const args = ['run', '--rm', '--network', 'none', '--entrypoint', 'hledger', '-v', `${o.dir}:/data:ro`, image, '-f', '/data/g001.journal', 'bal', account, `--forecast=${o.as_of}..${o.horizon_end}`, '-e', end];
    return { end, args, text: 'docker ' + args.map(quote).join(' ') };
  });
}

/** Подготовить случай: журнал G-001 и ожидаемые остатки. */
export async function prepare_case(dir) {
  const ws = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
  const { export_hledger_file } = await demo('data_actions.mjs');
  const E = await eng('index.mjs');
  const out = export_hledger_file(ws);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'g001.journal'), out.text, 'utf8');
  const analysis = E.analyze(ws, { as_of: ws.as_of });
  const expected = Object.fromEntries(CHECK_DAYS.map((d) => [d, expected_balance(analysis, d, E)]));
  // имя счёта в журнале — слаг от названия счёта («Основной счёт» → assets:основной-счёт): берём его из самого журнала, у G-001 единственный операционный счёт
  const account = /^\s+(assets:\S+)\s/m.exec(out.text)?.[1];
  if (account === undefined) throw new Error('в журнале нет счёта assets:…');
  return { ws, text: out.text, horizon_end: out.horizon_end, as_of: ws.as_of, expected, planned: out.planned, account };
}

function arg_of(argv, name, def) { const i = argv.indexOf(name); return i < 0 ? def : argv[i + 1]; }

async function main(argv) {
  const dir = path.resolve(arg_of(argv, '--dir', path.join(os.tmpdir(), 'runway-hledger-oracle')));
  const image = arg_of(argv, '--image', DEFAULT_IMAGE);
  const c = await prepare_case(dir);
  const cmds = build_commands({ dir, image, account: c.account, as_of: c.as_of, horizon_end: c.horizon_end });
  const doc = { dir, journal: path.join(dir, 'g001.journal'), account: c.account, planned_rules: c.planned, image, commands: cmds.map((x) => x.text), expected_minor: c.expected };
  if (argv.includes('--json')) console.log(JSON.stringify(doc, null, 2));
  else {
    console.log(`журнал G-001 записан: ${doc.journal} (разовых плановых правил: ${c.planned})`);
    console.log(`ожидаемые остатки счёта ${c.account} по ряду close движка (minor units): ` + JSON.stringify(c.expected));
    for (const x of cmds) console.log(x.text);
  }
  if (!argv.includes('--run')) { if (!argv.includes('--json')) console.log('Docker не запускался (нужен ключ --run). Образ ' + image + ' не проверен проектом (не подтверждено).'); return 0; }
  const probe = spawnSync('docker', ['version', '--format', '{{.Client.Version}}'], { encoding: 'utf8', timeout: 20000 });
  if (probe.status !== 0) { console.error('Docker не найден или не отвечает: оракул не запускался'); return 2; }
  let bad = 0;
  for (const x of cmds) {
    const r = spawnSync('docker', x.args, { encoding: 'utf8', timeout: 120000 });
    const got = r.status === 0 ? parse_balance_line(r.stdout.split('\n').find((l) => /EUR/.test(l)) ?? '') : null;
    const want = c.expected[x.end];
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok ' : 'НЕТ'} -e ${x.end}: hledger ${got === null ? '(нет числа; код ' + r.status + ')' : got} ожидалось ${want}`);
  }
  return bad === 0 ? 0 : 1;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
