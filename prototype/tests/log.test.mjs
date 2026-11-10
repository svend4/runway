// log.test.mjs — логгер с белым списком полей и отчёт об ошибке по согласию (FP-05): REQ-124, TST-46.
// Красный тест: запись amount_minor или описания в лог — исключение; в сборке демо нет вызовов console.* (линтер по исходникам).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { create_logger, sanitize_fields, build_error_report, report_text, LogError, LOG_FIELDS, LOG_MAX_STRING, LOG_RING, log } from '../demo/log.mjs';

const DEMO = fileURLToPath(new URL('../demo/', import.meta.url));

test('TST-46 REQ-124 белый список полей: id, n, ms, code, engine_version — ровно пять', () => {
  assert.deepEqual([...LOG_FIELDS], ['id', 'n', 'ms', 'code', 'engine_version']);
  assert.ok(Object.isFrozen(LOG_FIELDS));
});

test('TST-46 REQ-124 строгий (тестовый) режим: amount_minor, desc, note, name, tag — исключение log_field_forbidden; имя поля в ошибке, значения — нет', () => {
  const lg = create_logger({ strict: true });
  for (const key of ['amount_minor', 'desc', 'note', 'name', 'tag', 'counterparty', 'description', 'balance']) {
    assert.throws(() => lg.info('event_ok', { [key]: 'секретное описание 4730' }), (e) => e instanceof LogError && e.code === 'log_field_forbidden' && e.field === key && !String(e.message).includes('секретное'), key);
  }
  assert.equal(lg.entries().length, 0, 'после отказов в логе пусто');
  // допустимая запись проходит
  const e = lg.info('store_open', { id: 'evt~000001', n: 47, ms: 12.5, code: 'store_conflict', engine_version: '0.1.0' });
  assert.deepEqual({ ...e }, { level: 'info', event: 'store_open', id: 'evt~000001', n: 47, ms: 12.5, code: 'store_conflict', engine_version: '0.1.0' });
});

test('TST-46 REQ-124 строгий режим: негодное значение белого поля (число строкой, NaN, код с пробелами) — log_value_invalid; негодное имя события — log_event_invalid', () => {
  const lg = create_logger({ strict: true });
  for (const bad of [{ n: '47' }, { n: Number.NaN }, { n: -1 }, { ms: Infinity }, { code: 'не код' }, { code: 'a b' }, { id: '' }, { id: {} }, { engine_version: 5 }]) {
    assert.throws(() => lg.info('e', bad), (e) => e.code === 'log_value_invalid', JSON.stringify(bad));
  }
  for (const ev of ['', 'Event', '1abc', 'a.b', 'x'.repeat(40), 5, null]) assert.throws(() => lg.info(ev, {}), (e) => e.code === 'log_event_invalid', String(ev));
  assert.throws(() => lg.info('e', 'строка'), (e) => e.code === 'log_value_invalid');
});

test('TST-46 REQ-124 обычный режим: лишние поля отбрасываются и считаются, остальное записывается; приёмник получает копию', () => {
  const got = [];
  const lg = create_logger({ sink: (x) => got.push(x) });
  const e = lg.warn('write_failed', { code: 'store_failed', amount_minor: -4730, note: 'аренда', n: 3 });
  assert.deepEqual({ ...e }, { level: 'warn', event: 'write_failed', code: 'store_failed', n: 3 });
  assert.equal(lg.dropped(), 2);
  assert.deepEqual(got, [{ level: 'warn', event: 'write_failed', code: 'store_failed', n: 3 }]);
  got[0].n = 99; // правка копии не меняет лог
  assert.equal(lg.entries()[0].n, 3);
  assert.equal(lg.error('Плохое имя'), null, 'негодное имя события: запись не создаётся');
  assert.equal(lg.dropped(), 3);
  lg.clear();
  assert.deepEqual([lg.entries().length, lg.dropped()], [0, 0]);
});

test('TST-46 REQ-124 строки длиннее 32 знаков срезаются; id очищается от знаков вне безопасного набора', () => {
  const lg = create_logger({ strict: true });
  const long = 'x'.repeat(100);
  const e = lg.info('e', { id: long, engine_version: '1.2.3' + 'y'.repeat(100) });
  assert.equal(e.id.length, LOG_MAX_STRING);
  assert.ok(e.id.endsWith('…'));
  assert.equal(e.engine_version.length, LOG_MAX_STRING);
  const e2 = lg.info('e', { id: 'Зарплата октябрь 4730' });
  assert.ok(/^[A-Za-z0-9_.:~@/?-]+$/.test(e2.id), 'кириллица и пробелы заменены: ' + e2.id);
  assert.equal(lg.info('e', { id: 7 }).id, 7, 'целое число — допустимый id');
  assert.throws(() => lg.info('e', { id: 1.5 }), (x) => x.code === 'log_value_invalid');
  assert.equal(lg.info('e', { code: 'E'.repeat(40) }).code.length, LOG_MAX_STRING, 'код тоже срезается до 32');
  assert.throws(() => lg.info('e', { code: 'Плохой код' }), (x) => x.code === 'log_value_invalid', 'код — только латиница, цифры и _.:-: текст в код не пролезет');
});

test('TST-46 REQ-124 кольцо записей: хранится не больше LOG_RING', () => {
  const lg = create_logger({ ring: 5 });
  for (let i = 0; i < 12; i++) lg.info('tick', { n: i });
  assert.deepEqual(lg.entries().map((x) => x.n), [7, 8, 9, 10, 11]);
  assert.equal(LOG_RING, 200);
});

test('TST-46 REQ-124 отчёт об ошибке: без согласия не строится; по согласию — только поля белого списка, код берётся из ошибки, текст сообщения и контекст не входят', () => {
  assert.deepEqual(build_error_report({ error: { code: 'E_SCHEMA' } }), { ok: false, reason: 'consent_required' });
  assert.deepEqual(build_error_report({ error: { code: 'E_SCHEMA' }, consent: 'yes' }), { ok: false, reason: 'consent_required' });
  const err = Object.assign(new Error('E_SCHEMA аренда -4730 EUR'), { code: 'E_SCHEMA', ctx: { note: 'аренда', amount_minor: -4730 } });
  const r = build_error_report({ error: err, consent: true, id: 'evt~000010', n: 47, ms: 12, engine_version: '0.1.0', amount_minor: -4730, desc: 'аренда' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.fields).sort(), ['code', 'engine_version', 'id', 'ms', 'n']);
  assert.equal(r.text, 'id: evt~000010\nn: 47\nms: 12\ncode: E_SCHEMA\nengine_version: 0.1.0', 'пользователь видит полный текст отчёта');
  assert.ok(!/аренд|4730/.test(r.text));
  assert.equal(report_text(r.fields), r.text);
  const long = build_error_report({ error: { code: 'E_X' }, consent: true, id: 'q'.repeat(80) });
  assert.ok(long.fields.id.length <= LOG_MAX_STRING);
  assert.equal(build_error_report({ consent: true }).fields.code, 'E_UNKNOWN');
});

test('TST-46 REQ-124 sanitize_fields: прототипные ключи и не-объект', () => {
  assert.throws(() => sanitize_fields(JSON.parse('{"__proto__": 1}'), { strict: true }), (e) => e.code === 'log_field_forbidden');
  assert.deepEqual(sanitize_fields(undefined), { fields: {}, dropped: 0 });
  assert.deepEqual(sanitize_fields([1], {}), { fields: {}, dropped: 1 });
  assert.equal(Object.keys(sanitize_fields({ n: 1 }).fields).length, 1);
  assert.equal(log.strict, false, 'логгер приложения — обычный режим');
});

/** Убрать комментарии и строки, чтобы искать вызовы `console.*` в КОДЕ. */
function code_only(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');
}

test('TST-46 REQ-124 в сборке демо нет вызовов console.* (линтер по исходникам demo/**/*.mjs)', () => {
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (n.name.endsWith('.mjs')) files.push(p); } };
  walk(DEMO);
  assert.ok(files.length > 15);
  for (const f of files) {
    const code = code_only(fs.readFileSync(f, 'utf8'));
    assert.ok(!/\bconsole\s*\./.test(code), `${path.relative(DEMO, f)}: вызов console.*`);
  }
});

// ── охват линтера (FP-22, REQ-124): не только demo/, но и движок, командная строка и мини-сервер ────────────────────────

const PROTO = fileURLToPath(new URL('../', import.meta.url));

test('TST-46 REQ-124 охват линтера console.*: engine/**/*.mjs, cli.mjs и serve.mjs тоже без вызовов console.* (вывод командной строки — process.stdout/stderr, а не консоль и не лог)', () => {
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (n.name.endsWith('.mjs')) files.push(p); } };
  walk(path.join(PROTO, 'engine'));
  const engine_count = files.length;
  assert.ok(engine_count >= 30, `модулей движка в охвате: ${engine_count}`);
  files.push(path.join(PROTO, 'cli.mjs'), path.join(PROTO, 'serve.mjs'));
  for (const f of files) {
    assert.ok(fs.existsSync(f), `нет файла ${path.relative(PROTO, f)}`);
    const code = code_only(fs.readFileSync(f, 'utf8'));
    assert.ok(!/\bconsole\s*\./.test(code), `${path.relative(PROTO, f)}: вызов console.*`);
    assert.ok(!/\bconsole\s*\[/.test(code), `${path.relative(PROTO, f)}: console[...]`);
    assert.ok(!/\b(?:globalThis|window|self)\s*\.\s*console\b/.test(code), `${path.relative(PROTO, f)}: обращение к console через глобальный объект`);
  }
});

test('TST-46 REQ-124 линтер console.* ловит нарушение: проверка на искусственных исходниках (вызов в коде — красный, в комментарии и в строке — нет)', () => {
  const bad = (src) => /\bconsole\s*\./.test(code_only(src));
  assert.equal(bad('export const f = (x) => { console.log(x); };'), true);
  assert.equal(bad('const a = 1;\n  console\n  .warn(a)'), true);
  assert.equal(bad('// console.log(1)\nconst s = "console.log(1)";\n/* console.error(2) */'), false);
  assert.equal(bad("process.stdout.write('ok\\n');"), false);
});

test('TST-46 REQ-124 log.mjs чист: нет импортов, часов, случайности, сети и консоли; подписка на глобальные ошибки не читает ничего, кроме кода и стандартного имени ошибки', () => {
  const src = fs.readFileSync(path.join(DEMO, 'log.mjs'), 'utf8');
  const code = code_only(src);
  assert.ok(!/^\s*import\s/m.test(src), 'модуль без импортов');
  for (const bad of ['Date', 'performance', 'Math.random', 'fetch', 'XMLHttpRequest', 'console', 'localStorage', '.message', '.stack', 'filename', 'lineno']) assert.ok(!code.includes(bad), 'в коде log.mjs нет: ' + bad);
});
