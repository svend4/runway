// build_info.mjs — ГЕНЕРИРУЕТСЯ tools/build_manifest.mjs, руками не править (FP-12, REQ-154).
// Хэш сборки — sha256 от списка «путь + sha256 файла» оболочки (манифест — demo/shell_manifest.json); число файлов — сколько их хранит кэш воркера.
// Проверить: node tools/verify.mjs. Пересобрать после любой правки demo/, engine/ или data/: node tools/build_manifest.mjs.

export const BUILD = Object.freeze({
  format: 'runway-shell/1',
  build_hash: '867a0b6b3823f2046f8e06bfcc00ecc9445d0a90ab180d78dfb4009e3db309e4',
  files: 227,
});
