// build_manifest.test.mjs — FP-12, REQ-154 (воспроизводимая сборка и опубликованные хэши), REQ-120 (список файлов оболочки = манифест), REQ-187 (фикстуры формата):
// обход ссылок, манифест sha256, двойная сборка даёт побайтно тот же результат (и из другой копии каталога), чувствительность хэша к файлам оболочки и нечувствительность
// к остальным, штампы sw.js и build_info.mjs, tools/verify.mjs (локально, «по сети» на заглушке, фикстуры формата). Рабочее дерево не меняется: сборки идут в копиях во временном каталоге.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTO } from './sw_harness.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const BM = await imp('tools', 'build_manifest.mjs');
const VF = await imp('tools', 'verify.mjs');
const IO = await imp('engine', 'io.mjs');
const LEDGER = await imp('engine', 'ledger.mjs');
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const sha = (x) => createHash('sha256').update(x).digest('hex');

/** Копия demo/, engine/, data/ и tests/fixtures/ во временном каталоге; вернуть корень копии. */
function copy_tree(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-build-' + label + '-'));
  for (const d of ['demo', 'engine', 'data']) fs.cpSync(path.join(PROTO, d), path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests', 'fixtures'), { recursive: true });
  for (const f of ['FIXTURES.json', 'journal-v1.json']) fs.copyFileSync(path.join(PROTO, 'tests', 'fixtures', f), path.join(root, 'tests', 'fixtures', f));
  return root;
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });
const snapshot_of = (root) => Object.fromEntries([BM.MANIFEST_PATH, BM.INFO_PATH, BM.SW_PATH].map((p) => [p, fs.readFileSync(path.join(root, p), 'utf8')]));

// ── обход ссылок ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-120 refs_of_module: импорты (в том числе многострочные), динамический import, new URL(…, import.meta.url), CSS пакетов и наборы данных; комментарии, node: и пакеты не считаются', () => {
  const src = [
    '// Расчёт идёт в этой странице: движок `../engine/*.mjs` вызывается напрямую; сеть нужна только',
    "import {",
    '  a, b,',
    "} from '../engine/index.mjs';",
    "import x from './x.mjs';",
    "import './side.mjs';",
    "export { y } from './y.mjs';",
    "import fs from 'node:fs';",
    "import pkg from 'left-pad';",
    "const L = () => import('./lazy.mjs');",
    "const w = new Worker(new URL('calc_worker.mjs', import.meta.url), { type: 'module' });",
    "const own = new URL('../', import.meta.url);",
    "const abs = new URL('https://example.org/x.js', import.meta.url);",
    "ext.ensure_css('css/p.css');",
    "const D = [{ file: '../data/g001.json' }];",
    "/* import z from './commented.mjs'; */",
    "// import q from './line_comment.mjs';",
    "const s = 'text import w from \"./in_string_ignored_only_if_no_from\"';",
    "export const NAME = 'plain';",
  ].join('\n');
  const refs = BM.refs_of_module(src).sort();
  assert.deepEqual(refs, ['../data/g001.json', '../engine/index.mjs', './lazy.mjs', './side.mjs', './x.mjs', './y.mjs', 'calc_worker.mjs', 'css/p.css'].sort());
  assert.deepEqual(BM.refs_of_module("const t = 'http://x.example/a.js'; // import a from './b.mjs'\n"), []);
});

test('REQ-120 collect_shell на рабочем дереве: от index.html, v0.html и sw.js доходит до всех модулей, стилей, наборов данных и иконок; в оболочку не попадают README, реестр обещаний, vocab.json и зеркала данных; backtest.mjs входит с FP-22 (metrics_feed читает фактический ряд окна)', () => {
  const c = BM.collect_shell(PROTO);
  assert.deepEqual([c.missing, c.outside], [[], []]);
  for (const need of ['demo/index.html', 'demo/v0.html', 'demo/app.mjs', 'demo/sw.js', 'demo/pwa.mjs', 'demo/about.mjs', 'demo/build_info.mjs', 'demo/calc_worker.mjs', 'demo/worker_client.mjs', 'demo/pack_fp12.mjs',
    'demo/css/about.css', 'demo/css/start.css', 'demo/i18n/about.mjs', 'demo/manifest.webmanifest', 'demo/icons/icon.svg', 'demo/icons/icon-maskable.svg', 'demo/style.css', 'demo/css/v0.css',
    'engine/index.mjs', 'engine/money.mjs', 'engine/band_adapter.mjs', 'engine/backtest.mjs', 'demo/metrics_feed.mjs', 'demo/pack_fp22.mjs', 'demo/css/error_report.css', 'demo/i18n/errrep.mjs', 'data/g001.json', 'data/g001-empty.json', 'data/synthetic-journals/generate.mjs']) assert.ok(c.files.includes(need), need);
  for (const not of ['demo/README_ext.md', 'demo/promises.json', 'demo/.htaccess', 'demo/shell_manifest.json', 'engine/vocab.json', 'data/golden-g001.json', 'data/backtest-report.json',
    'data/templates/freelancer-skeleton.json', 'data/profiles/csv-generic.json', 'data/synthetic-journals/manifest.json', 'data/synthetic-journals/write_manifest.mjs']) assert.ok(!c.files.includes(not), 'не оболочка: ' + not);
  assert.deepEqual(c.files, [...c.files].sort());
  assert.ok(c.files.every((p) => /^(demo|engine|data)\//.test(p) && !p.includes('..') && !p.includes('\\')));
});

// ── воспроизводимость ──────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-154 двойная сборка даёт побайтно тот же манифест, build_info.mjs и sw.js; сборка из другой копии каталога с другими временами файлов — тоже; в манифесте нет меток времени и абсолютных путей', () => {
  const a = copy_tree('a');
  const b = copy_tree('b');
  try {
    const r1 = BM.write_build(a);
    const first = snapshot_of(a);
    const r2 = BM.write_build(a);
    assert.deepEqual(r2.written, [], 'вторая сборка ничего не меняет');
    assert.deepEqual(snapshot_of(a), first, 'двойная сборка: побайтно');
    assert.equal(r1.manifest.build_hash, r2.manifest.build_hash);
    // другая копия: свежие и древние времена изменения файлов, другой путь
    for (const f of BM.collect_shell(b).files) fs.utimesSync(path.join(b, f), new Date(2001, 0, 1 + (f.length % 28)), new Date(2001, 0, 1 + (f.length % 28)));
    BM.write_build(b);
    assert.deepEqual(snapshot_of(b), first, 'сборка из другого каталога с другими mtime даёт тот же результат');
    // и совпадает с тем, что записано в рабочем дереве (актуальность манифеста)
    assert.equal(first[BM.MANIFEST_PATH], read('demo', 'shell_manifest.json'), 'манифест в demo/ — результат сборки текущих файлов (если красный: node tools/build_manifest.mjs)');
    assert.equal(first[BM.INFO_PATH], read('demo', 'build_info.mjs'));
    assert.equal(first[BM.SW_PATH], read('demo', 'sw.js'));
    const text = first[BM.MANIFEST_PATH];
    assert.ok(!/\d{4}-\d{2}-\d{2}T|mtime|timestamp|[A-Za-z]:\\|\/Users\/|\/home\/|runway-build-/.test(text), 'ни меток времени, ни абсолютных путей');
    assert.ok(!text.includes('\r'), 'LF');
    const m = JSON.parse(text);
    assert.equal(m.format, 'runway-shell/1');
    assert.match(m.build_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(m), ['format', 'engine_version', 'build_hash', 'files', 'stamped']);
    assert.deepEqual(m.stamped.map((s) => s.path), ['demo/build_info.mjs', 'demo/sw.js']);
    assert.ok(m.files.every((f) => Object.keys(f).join() === 'path,sha256,bytes' && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isSafeInteger(f.bytes)));
  } finally { rm(a); rm(b); }
});

test('REQ-154 манифест в рабочем дереве актуален: записанные манифест, build_info.mjs и штамп sw.js равны пересчитанным (после любой правки demo/, engine/, data/ — node tools/build_manifest.mjs)', () => {
  const r = BM.check_build(PROTO);
  assert.deepEqual(r.problems, [], 'запустите node tools/build_manifest.mjs');
  assert.equal(r.ok, true);
  const m = JSON.parse(read('demo', 'shell_manifest.json'));
  assert.equal(r.build_hash, m.build_hash);
  assert.match(m.engine_version, /^\d+\.\d+\.\d+$/);
  assert.equal(BM.stamp_of_sw(read('demo', 'sw.js')), m.build_hash);
  assert.match(read('demo', 'build_info.mjs'), new RegExp(`build_hash: '${m.build_hash}'`));
  assert.match(read('demo', 'build_info.mjs'), new RegExp(`files: ${BM.precache_list(m).length},`));
});

test('REQ-154 чувствительность хэша: правка файла оболочки меняет хэш сборки и запись этого файла; правка вне оболочки (README, тесты, реестр обещаний) — нет; новый импортируемый модуль входит в манифест', () => {
  const a = copy_tree('sens');
  try {
    const base = BM.write_build(a).manifest;
    const money = path.join(a, 'engine', 'money.mjs');
    fs.appendFileSync(money, '\n// правка\n');
    const changed = BM.write_build(a).manifest;
    assert.notEqual(changed.build_hash, base.build_hash);
    const diff = changed.files.filter((f, i) => f.sha256 !== base.files[i].sha256).map((f) => f.path);
    assert.deepEqual(diff, ['engine/money.mjs'], 'изменилась ровно запись правленого файла');
    const stamped_changed = changed.stamped.map((s) => s.sha256) .join() !== base.stamped.map((s) => s.sha256).join();
    assert.equal(stamped_changed, true, 'штампованные файлы следуют за хэшем сборки');
    // вне оболочки
    fs.appendFileSync(path.join(a, 'demo', 'README_ext.md'), '\nдопись\n');
    fs.writeFileSync(path.join(a, 'demo', 'promises.json'), '[]\n');
    assert.equal(BM.write_build(a).manifest.build_hash, changed.build_hash, 'файлы вне оболочки хэш не меняют');
    // новый модуль, подключённый импортом из пакета, входит в манифест; без импорта — не входит
    fs.writeFileSync(path.join(a, 'demo', 'zz_new.mjs'), 'export const Z = 1;\n');
    assert.ok(!BM.collect_shell(a).files.includes('demo/zz_new.mjs'));
    const pack = path.join(a, 'demo', 'pack_fp12.mjs');
    fs.appendFileSync(pack, "\nimport { Z } from './zz_new.mjs';\nexport const KEEP_Z = Z;\n");
    const grown = BM.write_build(a).manifest;
    assert.ok(grown.files.some((f) => f.path === 'demo/zz_new.mjs'));
    assert.equal(grown.files.length, base.files.length + 1);
    // импорт несуществующего файла — ошибка проверки
    fs.appendFileSync(pack, "import { Q } from './no_such.mjs';\nexport const KEEP_Q = Q;\n");
    const bad = BM.check_build(a);
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((p) => p.includes('no_such.mjs')), bad.problems.join('\n'));
  } finally { rm(a); }
});

test('REQ-154 build_hash_of и штампы: хэш от строк «путь\\tsha256\\n» с меткой формата; stamp_sw подставляет хэш между метками и читается обратно; без меток — ошибка', () => {
  const files = [{ path: 'a/x.mjs', sha256: sha('x') }, { path: 'b/y.mjs', sha256: sha('y') }];
  const expect = sha('runway-shell/1\n' + 'a/x.mjs\t' + sha('x') + '\n' + 'b/y.mjs\t' + sha('y') + '\n');
  assert.equal(BM.build_hash_of(files), expect);
  assert.notEqual(BM.build_hash_of([files[1], files[0]]), expect, 'порядок входит в хэш (в сборке пути отсортированы)');
  const sw = read('demo', 'sw.js');
  const h = 'ab'.repeat(32);
  const stamped = BM.stamp_sw(sw, h);
  assert.equal(BM.stamp_of_sw(stamped), h);
  assert.equal(BM.stamp_sw(stamped, h), stamped, 'повторный штамп тем же хэшем ничего не меняет');
  assert.equal(stamped.replace(h, BM.ZERO_HASH).length, sw.length);
  assert.throws(() => BM.stamp_sw('const x = 1;', h), /BUILD:BEGIN/);
  assert.equal(BM.stamp_of_sw('const x = 1;'), null);
  assert.match(BM.build_info_text(h, 7), /build_hash: 'abab/);
  assert.equal(BM.build_info_text(h, 7), BM.build_info_text(h, 7));
});

test('REQ-154 командная строка: --check на рабочем дереве — код 0; на копии с правкой — код 1; --print печатает хэш; неизвестный ключ — код 2; рабочее дерево не меняется', () => {
  const tool = path.join(PROTO, 'tools', 'build_manifest.mjs');
  const before = snapshot_of(PROTO);
  const ok = spawnSync(process.execPath, [tool, '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /актуален, хэш сборки [0-9a-f]{64}/);
  const printed = spawnSync(process.execPath, [tool, '--print'], { encoding: 'utf8' });
  assert.equal(printed.status, 0);
  assert.ok(printed.stdout.startsWith(JSON.parse(read('demo', 'shell_manifest.json')).build_hash));
  const a = copy_tree('cli');
  try {
    BM.write_build(a);
    fs.appendFileSync(path.join(a, 'engine', 'dates.mjs'), '\n// правка\n');
    const stale = spawnSync(process.execPath, [tool, '--check', '--root', a], { encoding: 'utf8' });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /shell_manifest\.json: расходится/);
    const fixed = spawnSync(process.execPath, [tool, '--root', a], { encoding: 'utf8' });
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.equal(spawnSync(process.execPath, [tool, '--check', '--root', a], { encoding: 'utf8' }).status, 0);
  } finally { rm(a); }
  assert.equal(spawnSync(process.execPath, [tool, '--нет-такого'], { encoding: 'utf8' }).status, 2);
  assert.deepEqual(snapshot_of(PROTO), before, 'проверки рабочее дерево не меняют');
});

// ── verify.mjs ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-154 verify_local: рабочее дерево сходится с манифестом; повреждённый файл, пропавший файл, лишняя ссылка, неверный штамп и неверный build_info называются по имени', () => {
  const ok = VF.verify_local(PROTO);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, JSON.parse(read('demo', 'shell_manifest.json')).files.length + 2);
  const a = copy_tree('verify');
  try {
    BM.write_build(a);
    assert.equal(VF.verify_local(a).ok, true);
    fs.appendFileSync(path.join(a, 'engine', 'tax.mjs'), '\n// правка\n');
    const p1 = VF.verify_local(a).problems;
    assert.ok(p1.some((p) => p.startsWith('engine/tax.mjs: sha256')), p1.join('\n'));
    assert.ok(p1.some((p) => p.startsWith('engine/tax.mjs: размер')));
    fs.rmSync(path.join(a, 'data', 'g001-low.json'));
    assert.ok(VF.verify_local(a).problems.some((p) => p === 'data/g001-low.json: файла нет'));
    BM.write_build(a); // после пересборки список файлов оболочки: g001-low.json пропал из DATASETS? — нет, ссылка осталась, значит это «ссылка на несуществующий файл»
    assert.ok(VF.verify_local(a).problems.some((p) => p.includes('g001-low.json')));
    fs.copyFileSync(path.join(PROTO, 'data', 'g001-low.json'), path.join(a, 'data', 'g001-low.json'));
    BM.write_build(a);
    assert.equal(VF.verify_local(a).ok, true);
    fs.writeFileSync(path.join(a, 'demo', 'sw.js'), BM.stamp_sw(fs.readFileSync(path.join(a, 'demo', 'sw.js'), 'utf8'), 'ee'.repeat(32)));
    assert.ok(VF.verify_local(a).problems.some((p) => p.includes('штамп сборки')));
    BM.write_build(a);
    fs.appendFileSync(path.join(a, 'demo', 'build_info.mjs'), '// вставка\n');
    assert.ok(VF.verify_local(a).problems.some((p) => p.startsWith('demo/build_info.mjs')));
    fs.rmSync(path.join(a, BM.MANIFEST_PATH));
    assert.equal(VF.verify_local(a).ok, false);
  } finally { rm(a); }
});

test('REQ-154 verify_remote: файлы, которые отдаёт хост, сверяются с манифестом (на заглушке «сети» — файлы с диска); подмена, 404 и недоступный хост называются по имени', async () => {
  const manifest = JSON.parse(read('demo', 'shell_manifest.json'));
  const base = 'http://localhost/01/301/runway/prototype/';
  const served = (over = {}) => async (url) => {
    const rel = url.slice(base.length);
    if (Object.hasOwn(over, rel)) { const v = over[rel]; if (v === null) throw new TypeError('offline'); if (v === 404) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; return { ok: true, arrayBuffer: async () => Buffer.from(v) }; }
    return { ok: true, arrayBuffer: async () => fs.readFileSync(path.join(PROTO, rel)) };
  };
  const good = await VF.verify_remote(manifest, base, served());
  assert.deepEqual(good.problems, []);
  assert.equal(good.checked, BM.precache_list(manifest).length);
  const bad = await VF.verify_remote(manifest, base, served({ 'engine/money.mjs': 'export const x = 1;', 'data/g001.json': 404, 'engine/dates.mjs': null }));
  assert.deepEqual(bad.problems.sort(), ['data/g001.json: ответ 404', 'engine/dates.mjs: хост недоступен', 'engine/money.mjs: отданный файл не совпадает с манифестом'].sort());
  assert.equal(bad.ok, false);
});

test('REQ-187 фикстуры формата: каждая запись tests/fixtures/FIXTURES.json импортируется движком и даёт заявленные формат, число записей и state_hash; подмена хэша или формата называется по имени', () => {
  const eng = { read_journal_json: IO.read_journal_json, import_json: IO.import_json, state_hash: LEDGER.state_hash };
  const ok = VF.verify_fixtures(PROTO, eng);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.checked, 1);
  const decl = JSON.parse(read('tests', 'fixtures', 'FIXTURES.json'));
  assert.equal(decl.fixtures[0].state_hash, 'f4b11682044eb911add5a6223c88c67b0f07c504321081ac1bfcdfc8ad4dde88', 'хэш — golden из hardening.test.mjs (REQ-016), не вывод проверяемого кода');
  assert.equal(LEDGER.state_hash(IO.import_json(read('tests', 'fixtures', 'journal-v1.json'))), decl.fixtures[0].state_hash);
  const a = copy_tree('fx');
  try {
    const p = path.join(a, 'tests', 'fixtures', 'FIXTURES.json');
    const bad = JSON.parse(fs.readFileSync(p, 'utf8'));
    bad.fixtures[0].state_hash = '0'.repeat(64);
    bad.fixtures.push({ file: 'нет-такого.json', format: 'runway-journal/1', events: 1, state_hash: '0'.repeat(64) });
    fs.writeFileSync(p, JSON.stringify(bad));
    const r = VF.verify_fixtures(a, eng);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((x) => x.startsWith('journal-v1.json: state_hash')));
    assert.ok(r.problems.some((x) => x.startsWith('нет-такого.json: не импортируется')));
    assert.equal(VF.verify_fixtures(path.join(a, 'nowhere'), eng).ok, false);
  } finally { rm(a); }
});

// ── исправление ADV-03: текст воркера входит в хэш сборки ─────────────────────────────────────────────────────────────────

test('REQ-154 исправление ADV-03: текст sw.js без штампа входит в хэш сборки — правка одного воркера меняет хэш, core_sha256 и имя кэша; штамп хэш не меняет; verify называет воркер, правленый без пересборки', () => {
  const a = copy_tree('swcore');
  try {
    const sw_path = path.join(a, 'demo', 'sw.js');
    const base = BM.write_build(a).manifest;
    const sw0 = base.stamped.find((s) => s.path === BM.SW_PATH);
    const sw_src0 = fs.readFileSync(sw_path, 'utf8');
    assert.match(sw0.core_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(sw0), ['path', 'sha256', 'bytes', 'core_sha256']);
    assert.equal(sw0.core_sha256, BM.sw_core_sha256(sw_src0));
    assert.equal(base.build_hash, BM.build_hash_with_sw(base.files, sw0.core_sha256), 'хэш сборки = файлы + текст воркера без штампа');
    assert.notEqual(base.build_hash, BM.build_hash_of(base.files), 'без строки воркера хэш был бы другим (это и был дефект)');
    assert.ok(!Object.hasOwn(base.stamped.find((s) => s.path === BM.INFO_PATH), 'core_sha256'));
    // штамп (хэш в блоке BUILD) на core не влияет: иначе круг
    assert.equal(BM.sw_core_sha256(BM.stamp_sw(sw_src0, 'ab'.repeat(32))), sw0.core_sha256);
    assert.equal(BM.sw_core_sha256(BM.stamp_sw(sw_src0, BM.ZERO_HASH)), sw0.core_sha256);

    // правка логики воркера без пересборки: verify и --check называют воркер
    fs.appendFileSync(sw_path, '\n// исправление логики воркера\n');
    const stale = VF.verify_local(a).problems;
    assert.ok(stale.some((p) => p.startsWith('demo/sw.js') && p.includes('core_sha256')), stale.join('\n'));
    assert.ok(stale.some((p) => p.startsWith('demo/sw.js: sha256')), stale.join('\n'));
    assert.equal(BM.check_build(a).ok, false);

    // после пересборки: файлы оболочки те же, хэш сборки, core и имя кэша — новые
    const changed = BM.write_build(a).manifest;
    assert.deepEqual(changed.files, base.files, 'остальные файлы оболочки не менялись');
    assert.notEqual(changed.build_hash, base.build_hash);
    assert.notEqual(changed.stamped.find((s) => s.path === BM.SW_PATH).core_sha256, sw0.core_sha256);
    assert.notEqual('runway-shell-' + changed.build_hash.slice(0, 16), 'runway-shell-' + base.build_hash.slice(0, 16), 'новое имя кэша: воркер новой версии не пишет в кэш работающей');
    assert.equal(BM.stamp_of_sw(fs.readFileSync(sw_path, 'utf8')), changed.build_hash);
    assert.deepEqual(VF.verify_local(a).problems, []);
    // воспроизводимо: повторная сборка той же правки ничего не меняет
    assert.deepEqual(BM.write_build(a).written, []);

    // манифест без core_sha256 или с чужим core_sha256 verify не принимает
    const man_path = path.join(a, BM.MANIFEST_PATH);
    const good_text = fs.readFileSync(man_path, 'utf8');
    const m1 = JSON.parse(good_text);
    delete m1.stamped.find((s) => s.path === BM.SW_PATH).core_sha256;
    fs.writeFileSync(man_path, JSON.stringify(m1, null, 2) + '\n');
    assert.ok(VF.verify_local(a).problems.some((p) => p.includes('нет core_sha256')));
    const m2 = JSON.parse(good_text);
    m2.stamped.find((s) => s.path === BM.SW_PATH).core_sha256 = '0'.repeat(64);
    fs.writeFileSync(man_path, JSON.stringify(m2, null, 2) + '\n');
    assert.ok(VF.verify_local(a).problems.some((p) => p.includes('core_sha256')));
    fs.writeFileSync(man_path, good_text);
    assert.deepEqual(VF.verify_local(a).problems, []);

    // build_info.mjs в хэш не входит: его правка хэш не меняет, но verify её находит
    fs.appendFileSync(path.join(a, 'demo', 'build_info.mjs'), '// вставка\n');
    assert.ok(VF.verify_local(a).problems.some((p) => p.startsWith('demo/build_info.mjs')));
    assert.equal(BM.compute_build(a).manifest.build_hash, changed.build_hash, 'хэш не зависит от build_info.mjs');
  } finally { rm(a); }
});
