// browser_pass_w3a.test.mjs — регрессии по находкам ручного прохода демо в настоящем браузере после волны 3а (2026-10-23, wiki/product/16-prototype-findings.md).
// Заглушка DOM не видит поздних перерисовок от хранилища, поэтому здесь — статические проверки того, что исправление на месте; поведение подтверждено в браузере.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');
const read = (f) => fs.readFileSync(path.join(DEMO, f), 'utf8');

test('FP-17 браузер: «Вернуть по умолчанию» на «Настройках» — фокус возвращается и после поздней перерисовки от хранилища (хранитель фокуса, окно запроса), а не уходит на body', () => {
  const src = read('settings.mjs');
  assert.match(src, /import \{ create_focus_keeper \} from '\.\/focus_keep\.mjs';/);
  assert.match(src, /const FOCUS = create_focus_keeper\(\(\) => clock_ports\(\)\.now_ms\(\)\);/);
  assert.match(src, /if \(focus !== null\) \{ schedule_focus\(focus\); FOCUS\.request\(focus\); \}/, 'запрос фокуса при записи с экрана');
  assert.match(src, /FOCUS\.apply\(\);/, 'каждая отрисовка в окне запроса возвращает фокус, если он потерян');
  // прежняя защита (S1/FP-03) на месте: микрозадача и следующий такт
  assert.match(src, /Promise\.resolve\(\)\.then\(\(\) => focus_now\(false\)\);/);
  assert.match(src, /setTimeout\(\(\) => focus_now\(true\), 0\);/);
  // цель возврата после «Вернуть» в таблице — заголовок карточки, он существует и принимает фокус
  assert.match(src, /commit\(ctx, status, \[reset_edit\(key\)\], 'defaults', 'settings-defaults-title'\)/);
  assert.match(fs.readFileSync(path.join(DEMO, 'settings_defaults.mjs'), 'utf8'), /id: 'settings-defaults-title', tabindex: '-1'/);
});
