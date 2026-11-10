#!/usr/bin/env node
// Генерирует wiki/comparisons/feature-matrix.md из data/scorecards/*.json
// Использование: node tools/build_matrix.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, WIKI } from './lib.mjs';

const dir = join(ROOT, 'data', 'scorecards');
if (!existsSync(dir)) { console.error('нет data/scorecards'); process.exit(1); }

const AXES = [
  ['forecast_by_date', 'Прогноз по датам', 'Q1 · остаток на будущие даты'],
  ['can_i_afford', '«Могу купить?»', 'Q3 · what-if покупка на прогнозе'],
  ['recurring_and_waves', 'Повторы / волны', 'Q2 · запланированные операции и волны платежей'],
  ['sinking_funds', 'Редкие траты', 'амортизация годовых платежей'],
  ['tax_envelope', 'Налог. конверт', 'откладывание налога при поступлении дохода'],
  ['multi_currency', 'Мультивалюта', 'счета в разных валютах, курс операции'],
  ['hourly_income', 'Почасовой доход', 'ставка/часы, нерегулярный доход, инвойсы'],
  ['privacy_local_first', 'Приватность', 'self-host / локально / без агрегаторов'],
  ['import_export', 'Импорт/экспорт', 'CSV/OFX/банки/API, отсутствие lock-in'],
  ['ai_assistant', 'AI', 'ассистент, опирающийся на расчёт'],
  ['openness', 'Открытость', 'open source / API / расширяемость'],
];
const ICON = { full: '✅', partial: '🟡', none: '❌', unknown: '❓', claimed: '📢' };
const esc = (s = '') => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const cards = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
  try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); }
  catch (e) { console.error(`пропуск ${f}: ${e.message}`); return null; }
}).filter(Boolean);
const ORDER = ['target', 'forecast-first', 'biz-cashflow', 'envelope', 'open-source', 'plain-text', 'modern-saas', 'ru-consumer', 'mobile', 'spreadsheet', 'freelancer-tax', 'ai'];
cards.sort((a, b) => {
  if (a.slug === 'budget-guru') return -1;
  if (b.slug === 'budget-guru') return 1;
  return (ORDER.indexOf(a.category) - ORDER.indexOf(b.category)) || a.slug.localeCompare(b.slug);
});

const short = (n = '') => n.split(/[:(]/)[0].trim();
const lvl = (c, k) => c.support?.[k]?.level || 'unknown';
const out = [];
out.push('---', 'title: "Матрица возможностей инструментов"', 'type: comparison', 'status: reviewed',
  'summary: "Сводная таблица 11 осей × инструменты: что реально умеют, где пустые ниши. Генерируется из data/scorecards/*.json"',
  'sources: [raw/02-budgetguru-landing.md]', 'updated: 2026-10-04', '---', '');
out.push('# Матрица возможностей инструментов', '');
out.push('> Страница **генерируется** `node tools/build_matrix.mjs` из `data/scorecards/*.json` (по одному файлу на страницу `wiki/tools/`). Правьте scorecard и перегенерируйте — не саму таблицу.', '');
out.push('Обозначения: ✅ есть штатно · 🟡 частично / обходным путём · ❌ подтверждённо нет · ❓ не выяснено · 📢 только маркетинговое заявление (не проверено).', '');

out.push('## 1. Сводная матрица', '');
out.push(`| Инструмент | ${AXES.map((a) => a[1]).join(' | ')} |`);
out.push(`|---|${AXES.map(() => ':-:').join('|')}|`);
for (const c of cards) {
  out.push(`| [${esc(short(c.name))}](../tools/${c.slug}.md) | ${AXES.map(([k]) => ICON[lvl(c, k)] || '❓').join(' | ')} |`);
}
out.push('');

out.push('## 2. Охват по осям (вывод по таблице)', '');
out.push('| Ось | ✅ | 🟡 | 📢 | ❌ | ❓ | Кто закрывает полностью |', '|---|:-:|:-:|:-:|:-:|:-:|---|');
const gaps = [];
for (const [k, label] of AXES) {
  const n = { full: 0, partial: 0, claimed: 0, none: 0, unknown: 0 };
  const fulls = [];
  for (const c of cards) { const l = lvl(c, k); n[l] = (n[l] || 0) + 1; if (l === 'full') fulls.push(short(c.name)); }
  out.push(`| ${label} | ${n.full} | ${n.partial} | ${n.claimed} | ${n.none} | ${n.unknown} | ${fulls.length ? esc(fulls.join(', ')) : '—'} |`);
  if (n.full <= 1) gaps.push({ label, fulls: fulls.length, partial: n.partial });
}
out.push('');
out.push('### Где рынок «тонкий» (≤ 1 инструмента с полной поддержкой)', '');
if (gaps.length) {
  out.push('| Ось | Полная поддержка | Частичная |', '|---|:-:|:-:|');
  for (const g of gaps) out.push(`| ${g.label} | ${g.fulls} | ${g.partial} |`);
} else out.push('Таких осей нет.');
out.push('', '> Это нишевые возможности для Runway: если по оси почти никто не даёт ✅, её стоит делать сильной стороной (см. [Сравнение подходов](approach-comparison.md)).', '');

out.push('## 3. Цена и статус', '', '| Инструмент | Состав группы | Цена | Статус / заметка |', '|---|---|---|---|');
for (const c of cards) out.push(`| [${esc(short(c.name))}](../tools/${c.slug}.md) | ${esc(c.name)} | ${esc(c.price || '—')} | ${esc(c.status_note || '—')} |`);
out.push('');

out.push('## 4. Детали по осям', '');
for (const [k, label, desc] of AXES) {
  out.push(`### ${label}`, '', `*${desc}*`, '', '| Инструмент | Уровень | Примечание |', '|---|:-:|---|');
  for (const c of cards) {
    const s = c.support?.[k];
    out.push(`| ${esc(short(c.name))} | ${ICON[lvl(c, k)] || '❓'} | ${esc(s?.note || '—')} |`);
  }
  out.push('');
}

out.push('## 5. Что стоит взять / чего избегать (из scorecard)', '', '| Инструмент | Взять | Избегать |', '|---|---|---|');
for (const c of cards) out.push(`| ${esc(short(c.name))} | ${esc((c.borrow || []).join('; ') || '—')} | ${esc((c.avoid || []).join('; ') || '—')} |`);
out.push('');

out.push('## Связанные страницы', '');
for (const c of cards.slice(0, 6)) out.push(`- [${short(c.name)}](../tools/${c.slug}.md)`);
out.push('- [Сравнение подходов](approach-comparison.md)', '- [Разбор Budget Guru](budget-guru-teardown.md)', '');

writeFileSync(join(WIKI, 'comparisons', 'feature-matrix.md'), out.join('\n'), 'utf8');
console.log(`feature-matrix.md: ${cards.length} инструментов, ${gaps.length} «тонких» осей`);
