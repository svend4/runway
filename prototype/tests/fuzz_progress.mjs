// fuzz_progress.mjs — FP-24, REQ-158: ход длинного фаззинга для tools/fuzz_nightly.mjs. Если задана переменная RUNWAY_FUZZ_PROGRESS (путь к файлу), долгие циклы тестов
// (hardening, validate_ws, golden_properties) время от времени записывают в него {метка: {done, of}}; без переменной вызов ничего не делает и поведение тестов не меняется.
// Нужен затем, чтобы прогон, остановленный лимитом времени, оставил честное «сколько прогнано»: итоговая сводка раннера у остановленного процесса не печатается.
// Только для тестов: допустимы node:fs. Расчёт по введённым данным и правилам, не консультация.

import fs from 'node:fs';

const FILE = process.env.RUNWAY_FUZZ_PROGRESS;
const state = {};
const last = new Map();

/**
 * Сообщить, что в цикле `label` выполнено `done` шагов из `of`. Файл перезаписывается не чаще, чем раз в `of / 200` шагов (и в конце цикла); в нём все циклы процесса.
 * @param {string} label имя цикла (например, `validate_ws:workspaces`)
 * @param {number} done сколько шагов выполнено
 * @param {number} of сколько запланировано
 */
export function fuzz_progress(label, done, of) {
  if (FILE === undefined || FILE === '') return;
  const prev = last.get(label) ?? 0;
  if (done !== of && done - prev < Math.max(1, Math.floor(of / 200))) return;
  last.set(label, done);
  state[label] = { done, of };
  try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch { /* ход — справочная информация: сбой записи тест не роняет */ }
}
