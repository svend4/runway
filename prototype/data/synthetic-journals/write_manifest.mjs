// write_manifest.mjs — пересчитать manifest.json: хэши синтетических журналов (замок воспроизводимости генератора).
// Запуск: `node data/synthetic-journals/write_manifest.mjs` из каталога prototype/. Тест tests/backtest.test.mjs сверяет хэши с файлом:
// если генератор изменился намеренно — перегенерировать манифест отдельным коммитом. Это тестовая оснастка (node:fs допустим вне engine/).
import fs from 'node:fs';
import { make_journal, journal_hash, regular_corpus, stress_corpus } from './generate.mjs';

const out = { format: 'runway-synthetic-journals/1', note: 'СИНТЕТИЧЕСКИЕ журналы, не данные пользователей; хэш = sha256(canon(записи))', corpora: {} };
for (const [name, specs] of [['regular', regular_corpus()], ['stress', stress_corpus()]]) {
  out.corpora[name] = specs.map((spec) => {
    const j = make_journal(spec);
    return { id: spec.id, events: j.length, sha256: journal_hash(j) };
  });
}
fs.writeFileSync(new URL('./manifest.json', import.meta.url), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('manifest.json записан: ' + Object.entries(out.corpora).map(([k, v]) => `${k}=${v.length}`).join(', '));
