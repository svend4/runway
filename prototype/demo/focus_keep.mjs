// focus_keep.mjs — возврат фокуса после перерисовки экрана (FP-11, WCAG 2.4.3): действие убирает нажатую кнопку из страницы, и фокус падает на body.
// Хранилище (FP-05) после каждой записи просит `ctx.refresh()` ещё раз, поэтому запрос фокуса живёт `FOCUS_WINDOW_MS` и применяется после каждой отрисовки в этом окне,
// но только если фокус «потерян» (на `body` или нигде): чужой фокус (шапка, меню, диалог) не отбирается. Модуль без побочных эффектов при импорте.

import { el_by_id } from './dom.mjs';

/** Сколько мс после запроса отрисовки вправе вернуть фокус. */
export const FOCUS_WINDOW_MS = 3000;

/** Фокус потерян: на `body`, `html` или нигде (заглушка DOM без `activeElement` считается потерянным). */
export function focus_is_lost() {
  const doc = globalThis.document;
  const a = doc?.activeElement;
  return a === undefined || a === null || a === doc.body || a === doc.documentElement;
}

/**
 * Хранитель фокуса экрана.
 * @param {() => number} now_ms часы (порт; в тестах подменяются)
 * @returns {{request: (id: string) => void, apply: () => void, clear: () => void, pending: () => string|null}}
 */
export function create_focus_keeper(now_ms) {
  let target = null;
  let until = 0;
  return {
    /** Запросить фокус на узел с `id` после следующей отрисовки (и поздних перерисовок окна). */
    request(id) { target = id; until = now_ms() + FOCUS_WINDOW_MS; },
    /** Вызвать в конце отрисовки экрана: вернёт фокус, если он потерян, и снимет запрос по истечении окна. */
    apply() {
      if (target === null) return;
      if (now_ms() > until) { target = null; return; }
      const id = target;
      Promise.resolve().then(() => {
        if (!focus_is_lost()) return;
        const el = el_by_id(id) ?? el_by_id('view-title');
        if (el !== null && el !== undefined && typeof el.focus === 'function') el.focus();
      });
    },
    clear() { target = null; until = 0; },
    pending() { return target; },
  };
}
