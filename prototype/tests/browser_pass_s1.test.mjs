// browser_pass_s1.test.mjs — регрессии по находкам ручного прохода демо в настоящем браузере после этапа S1 (2026-10-09, wiki/product/16-prototype-findings.md).
// Заглушка DOM не видит перерисовок «в следующем такте», поэтому здесь — статические проверки того, что исправление на месте; поведение подтверждено в браузере.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');
const read = (f) => fs.readFileSync(path.join(DEMO, f), 'utf8');

test('S1.5 браузер: после правки из диалога «Править волну» фокус возвращается на кнопку карточки дважды — сразу и в следующем такте (вторая перерисовка от хранилища заменяет узел и роняет фокус на body)', () => {
  const src = read('wave_edit.mjs');
  assert.match(src, /const restore_focus = \(only_if_lost = false\) =>/, 'функция возврата фокуса с режимом «только если потерян»');
  assert.match(src, /close_dialog\(\);\s*restore_focus\(\);\s*setTimeout\(\(\) => restore_focus\(true\), 0\);/, 'сразу после закрытия и повтор в следующем такте');
  assert.match(src, /el_by_id\('wc-edit-' \+ key\) \?\? el_by_id\('view-title'\)/, 'цель — кнопка этой карточки, запасная — заголовок экрана');
  assert.match(src, /active !== doc\.body/, 'повтор не крадёт фокус, если пользователь уже сам куда-то перешёл');
});

test('S1.4 браузер: навигация на телефоне — нижняя панель в два ряда, действия прокручиваются по горизонтали (ограничение известно: «Вернуть» и «?» частично вне экрана 375 px)', () => {
  const css = read('style.css');
  assert.match(css, /@media \(max-width: 599px\) \{[^}]*\.nav \{ position: fixed;/s);
  assert.match(css, /\.nav \.nav-actions \{ flex-wrap: nowrap; overflow-x: auto; \}/);
  assert.doesNotMatch(css, /\.nav[^{]*\{[^}]*\border\s*:/, 'порядок фокуса = видимый порядок: CSS order в навигации не используется');
});

test('FP-03 браузер: фокус после «Сохранить» на экране «Настройки» возвращается и в следующем такте (поздняя перерисовка от хранилища заменяет поле, фокус уходил на body)', () => {
  const src = read('settings.mjs');
  assert.match(src, /Promise\.resolve\(\)\.then\(\(\) => focus_now\(false\)\);/);
  assert.match(src, /setTimeout\(\(\) => focus_now\(true\), 0\);/);
  assert.match(src, /active !== doc\.body/, 'повтор не отбирает фокус, если пользователь уже перешёл сам');
});

test('FP-05 браузер: «сегодня» для квитанции об удалении и напоминания о копии — местная дата, а не UTC (возле полуночи UTC-дата отстаёт на день)', () => {
  const src = read('pack_fp05.mjs');
  assert.match(src, /today: \(\) => local_today\(\{ now_ms: ports\.now_ms, tz_offset_min: clock_ports\(\)\.tz_offset_min \}\)/);
  assert.doesNotMatch(src, /instant_of_ms\(ports\.now_ms\(\)\)\.slice\(0, 10\)/, 'UTC-вариант убран');
});
