// ext_manifest.mjs — список пакетов расширений демо (FP-01). Пакеты фазы B лежат рядом: demo/pack_fp03.mjs … pack_fp29.mjs,
// каждый с экспортом `register(ext)` (может быть асинхронным). Загрузка — динамическим import() в try/catch (см. `ext.load_packs`):
// отсутствие файла — норма (пакет ещё не написан или не включён), падение пакета не ломает приложение.
// Строки импорта — литералы, чтобы набор файлов был виден статически; добавить пакет = добавить имя в `PACKS` и строку в `LOADERS`.
// Модуль не имеет побочных эффектов и ничего не загружает при импорте.

/** Имена пакетов в порядке загрузки (порядок влияет только на очерёдность регистрации; места в навигации задаёт `order`). */
export const PACKS = Object.freeze(['pack_fp03', 'pack_fp04', 'pack_fp05', 'pack_fp06', 'pack_fp07', 'pack_fp08', 'pack_fp09', 'pack_fp10', 'pack_fp11', 'pack_fp12', 'pack_fp13', 'pack_fp14', 'pack_fp15', 'pack_fp16', 'pack_fp20', 'pack_fp21', 'pack_fp22', 'pack_fp26', 'pack_fp28', 'pack_fp29']);

/** Загрузчики пакетов по имени: `() => import('./<имя>.mjs')`. */
export const LOADERS = Object.freeze({
  pack_fp03: () => import('./pack_fp03.mjs'),
  pack_fp04: () => import('./pack_fp04.mjs'),
  pack_fp05: () => import('./pack_fp05.mjs'),
  pack_fp06: () => import('./pack_fp06.mjs'),
  pack_fp07: () => import('./pack_fp07.mjs'),
  pack_fp08: () => import('./pack_fp08.mjs'),
  pack_fp09: () => import('./pack_fp09.mjs'),
  pack_fp10: () => import('./pack_fp10.mjs'),
  pack_fp11: () => import('./pack_fp11.mjs'),
  pack_fp12: () => import('./pack_fp12.mjs'),
  pack_fp13: () => import('./pack_fp13.mjs'),
  pack_fp14: () => import('./pack_fp14.mjs'),
  pack_fp15: () => import('./pack_fp15.mjs'),
  pack_fp16: () => import('./pack_fp16.mjs'),
  pack_fp20: () => import('./pack_fp20.mjs'),
  pack_fp21: () => import('./pack_fp21.mjs'),
  pack_fp22: () => import('./pack_fp22.mjs'),
  pack_fp26: () => import('./pack_fp26.mjs'),
  pack_fp28: () => import('./pack_fp28.mjs'),
  pack_fp29: () => import('./pack_fp29.mjs'),
});
