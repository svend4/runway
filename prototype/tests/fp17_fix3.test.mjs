// fp17_fix3.test.mjs — третья проверка FP-17, замечание low: «Откатить партию» в режиме «только чтение» должна называть причину (ro.refused),
// а не «Откат не выполнен: данные прежние» без причины (тот же класс, что Д1/С1 из fp17_fix2). Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (...p) => import(pathToFileURL(path.join(ROOT, ...p)).href);
const { rollback_ui, create_deps } = await imp('demo', 'import_wizard.mjs');
const { t } = await imp('demo', 'i18n.mjs');
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'g001.json'), 'utf8'));

const BATCH = 'imp_fix3_a';

/** Рабочая область с одной партией импорта: у первого факта проставлен batch_id. */
function ws_with_batch() {
  const ws = JSON.parse(JSON.stringify(G));
  ws.facts[0].batch_id = BATCH;
  return ws;
}

/** Фальшивый контекст: set_ws отвечает заданным результатом, уведомления копятся. */
function fake_ctx(ws, set_result, lang = 'ru') {
  const notes = [];
  return {
    notes,
    tr: (key, p) => t(lang, key, p),
    get_ws: () => ws,
    set_ws: () => set_result,
    notify: (text, kind) => notes.push({ text, kind }),
  };
}

for (const [lang, expect] of [['ru', /только для просмотра/], ['en', /viewing only/]]) {
  test(`FP-17 low: откат партии в режиме «только чтение» (${lang}) — в плашке и в уведомлении ro.refused, не «Откат не выполнен»`, () => {
    const ctx = fake_ctx(ws_with_batch(), { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'read_only' } } }, lang);
    const deps = create_deps({ parser: null });
    const ok = rollback_ui(ctx, deps, BATCH);
    assert.equal(ok, false);
    assert.equal(deps.notice.kind, 'error');
    assert.equal(deps.notice.key, 'ro.refused');
    const text = t(lang, deps.notice.key, deps.notice.params);
    assert.match(text, expect);
    assert.equal(ctx.notes.at(-1).text, text, 'уведомление совпадает с плашкой');
    assert.equal(ctx.notes.at(-1).kind, 'error');
    assert.doesNotMatch(ctx.notes.map((n) => n.text).join(' '), /E_SCHEMA/);
  });
}

test('FP-17 low: прочие отказы записи по-прежнему дают import.rb_failed (прежнее поведение не тронуто)', () => {
  for (const error of [{ code: 'E_SCHEMA', ctx: { reason: 'other' } }, { code: 'E_SCHEMA', ctx: null }, null, undefined]) {
    const ctx = fake_ctx(ws_with_batch(), { ok: false, error });
    const deps = create_deps({ parser: null });
    assert.equal(rollback_ui(ctx, deps, BATCH), false);
    assert.equal(deps.notice.key, 'import.rb_failed');
    assert.equal(ctx.notes.at(-1).text, t('ru', 'import.rb_failed'));
  }
});

test('FP-17 low: откат партии без отказа проходит как прежде (import.rolled_back), а неизвестная партия — import.rb_failed', () => {
  const ok_ctx = fake_ctx(ws_with_batch(), { ok: true });
  const deps = create_deps({ parser: null });
  assert.equal(rollback_ui(ok_ctx, deps, BATCH), true);
  assert.equal(deps.notice.key, 'import.rolled_back');
  assert.equal(deps.notice.params.id, BATCH);
  const unknown_ctx = fake_ctx(ws_with_batch(), { ok: true });
  const deps2 = create_deps({ parser: null });
  assert.equal(rollback_ui(unknown_ctx, deps2, 'imp_fix3_zz'), false);
  assert.equal(deps2.notice.key, 'import.rb_failed');
});
