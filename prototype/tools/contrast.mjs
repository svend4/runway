#!/usr/bin/env node
// contrast.mjs — проверка контраста токенов CSS по WCAG 2.2 (FP-12, REQ-166): светлая и тёмная темы style.css.
// Пары «цвет текста / фон» (обычный текст ≥ 4,5:1), «графика и индикатор фокуса» (≥ 3:1, критерий 1.4.11) и «граница поля ввода» (≥ 3:1) берутся из того, как токены
// используются в демо; пары-разделители (`--border` на карточке) выводятся справочно — они не несут смысла (критерий 1.4.11 их не требует).
// Темы: светлая — токены на `:root`; тёмная — `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` и `:root[data-theme="dark"]` (значения должны совпадать).
// Дополнительно проверяется, что остальные стили (`demo/css/*.css`) не вводят свои цвета: только `var(--токен)` (исключение — подложка диалога).
//   node tools/contrast.mjs            таблица по обеим темам; код выхода 1, если обязательная пара ниже порога
//   node tools/contrast.mjs --json     то же в JSON
// Яркость — по формуле WCAG с порогом 0,03928. Инструмент вне engine/: node:fs и process допустимы. Расчёт по введённым данным и правилам, не консультация.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Пороги WCAG 2.2 AA. */
export const THRESHOLDS = Object.freeze({ text: 4.5, graphic: 3, ui: 3 });

/** Пары «цвет / фон»: kind — text | graphic | ui | info (справочно, без порога). `where` — где пара встречается в стилях. */
export const PAIRS = Object.freeze([
  { fg: 'text', bg: 'bg', kind: 'text', where: 'основной текст на странице' },
  { fg: 'text', bg: 'surface', kind: 'text', where: 'текст в карточках, шапке, диалоге' },
  { fg: 'text', bg: 'surface-2', kind: 'text', where: 'заголовки таблиц, наведение, код' },
  { fg: 'text', bg: 'banner-bg', kind: 'text', where: 'плашки и выделенные строки таблиц' },
  { fg: 'text', bg: 'tight-bg', kind: 'text', where: 'плашка «впритык»' },
  { fg: 'text', bg: 'no-bg', kind: 'text', where: 'плашка «не хватает»' },
  { fg: 'muted', bg: 'bg', kind: 'text', where: 'вторичный текст на странице' },
  { fg: 'muted', bg: 'surface', kind: 'text', where: 'вторичный текст в карточках' },
  { fg: 'muted', bg: 'surface-2', kind: 'text', where: 'вторичный текст на подложке' },
  { fg: 'muted', bg: 'banner-bg', kind: 'text', where: 'вторичный текст в плашках' },
  { fg: 'accent-text', bg: 'accent', kind: 'text', where: 'главная кнопка, нажатый переключатель, ссылка «К содержимому»' },
  { fg: 'accent', bg: 'bg', kind: 'text', where: 'ссылки-кнопки на странице' },
  { fg: 'accent', bg: 'surface', kind: 'text', where: 'ссылки-кнопки в карточках' },
  { fg: 'ok', bg: 'ok-bg', kind: 'text', where: 'вердикт «выдерживает»' },
  { fg: 'fragile', bg: 'fragile-bg', kind: 'text', where: 'вердикт «хрупко»' },
  { fg: 'tight', bg: 'tight-bg', kind: 'text', where: 'вердикт «впритык»' },
  { fg: 'no', bg: 'no-bg', kind: 'text', where: 'вердикт «не хватает»' },
  { fg: 'ok', bg: 'surface', kind: 'text', where: 'положительные числа' },
  { fg: 'ok', bg: 'bg', kind: 'text', where: 'положительные числа на странице' },
  { fg: 'fragile', bg: 'surface', kind: 'text', where: 'метка «устарел»' },
  { fg: 'no', bg: 'surface', kind: 'text', where: 'ошибки и просрочка' },
  { fg: 'no', bg: 'bg', kind: 'text', where: 'ошибки на странице' },
  { fg: 'wave', bg: 'surface', kind: 'text', where: 'метки волн и подпись' },
  { fg: 'wave', bg: 'bg', kind: 'text', where: 'метки волн на странице' },
  { fg: 'wave', bg: 'banner-bg', kind: 'text', where: 'метки волн в плашках' },
  { fg: 'wave', bg: 'surface-2', kind: 'text', where: 'метка .tag и подпись .sc-ai внутри подложки (details.sc-chip)' },
  { fg: 'plan', bg: 'surface', kind: 'graphic', where: 'линия «по плану»' },
  { fg: 'worse', bg: 'surface', kind: 'graphic', where: 'линия «если хуже»' },
  { fg: 'buffer', bg: 'surface', kind: 'graphic', where: 'линия буфера' },
  { fg: 'muted', bg: 'surface', kind: 'graphic', where: 'ось, нуль, факт до сегодня' },
  { fg: 'wave', bg: 'surface', kind: 'graphic', where: 'штриховка волн' },
  { fg: 'text', bg: 'surface', kind: 'graphic', where: 'линия «сегодня»' },
  { fg: 'focus', bg: 'bg', kind: 'graphic', where: 'кольцо фокуса на странице' },
  { fg: 'focus', bg: 'surface', kind: 'graphic', where: 'кольцо фокуса в карточках' },
  { fg: 'focus', bg: 'surface-2', kind: 'graphic', where: 'кольцо фокуса на подложке' },
  { fg: 'control-border', bg: 'surface', kind: 'ui', where: 'граница поля ввода в карточке' },
  { fg: 'control-border', bg: 'bg', kind: 'ui', where: 'граница поля ввода на странице' },
  { fg: 'control-border', bg: 'surface-2', kind: 'ui', where: 'граница поля ввода на подложке' },
  { fg: 'border', bg: 'surface', kind: 'info', where: 'разделители и рамки карточек (смысла не несут)' },
  { fg: 'border', bg: 'bg', kind: 'info', where: 'разделители на странице (смысла не несут)' },
]);

// ── разбор CSS ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Убрать комментарии. */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Разобрать CSS на правила `{at, selector, decls}` с учётом вложенных `@media`.
 * @param {string} css
 * @returns {{at: string|null, selector: string, decls: Record<string, string>}[]}
 */
export function parse_rules(css) {
  const src = strip(css);
  const out = [];
  const walk = (text, at) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) { if (text[j] === '{') depth += 1; else if (text[j] === '}') depth -= 1; j += 1; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media') || head.startsWith('@supports')) walk(body, head);
      else if (!head.startsWith('@')) out.push({ at, selector: head.replace(/\s+/g, ' '), decls: decls_of(body) });
      i = j;
    }
  };
  walk(src, null);
  return out;
}

function decls_of(body) {
  const d = {};
  for (const part of body.split(';')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    const name = part.slice(0, k).trim();
    if (name !== '') d[name] = part.slice(k + 1).trim();
  }
  return d;
}

/** Токены трёх мест определения: светлая тема, тёмная по предпочтению системы, тёмная по `data-theme`. */
export function theme_tokens(css) {
  const rules = parse_rules(css);
  const pick = (pred) => {
    const r = rules.find(pred);
    if (r === undefined) return null;
    return Object.fromEntries(Object.entries(r.decls).filter(([k]) => k.startsWith('--')).map(([k, v]) => [k.slice(2), v]));
  };
  return {
    light: pick((r) => r.at === null && r.selector === ':root' && Object.hasOwn(r.decls, '--bg')),
    dark_auto: pick((r) => r.at === '@media (prefers-color-scheme: dark)' && r.selector === ':root:not([data-theme="light"])'),
    dark_manual: pick((r) => r.at === null && r.selector === ':root[data-theme="dark"]'),
  };
}

// ── яркость и контраст ────────────────────────────────────────────────────────────────────────────────────────────

/** `#rgb` / `#rrggbb` → [r, g, b] (0…255); иначе — `null`. */
export function parse_hex(value) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(value).trim());
  if (m === null) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Относительная яркость по WCAG (линеаризация sRGB, порог 0,03928). */
export function relative_luminance(rgb) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** Отношение контраста двух цветов (`#rrggbb`), от 1 до 21. */
export function contrast_ratio(a, b) {
  const pa = parse_hex(a);
  const pb = parse_hex(b);
  if (pa === null || pb === null) throw new RangeError('цвет не в форме #rgb/#rrggbb: ' + String(pa === null ? a : b));
  const [hi, lo] = [relative_luminance(pa), relative_luminance(pb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ── проверка ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Фоны страницы, на которых может лежать текст без собственного фона: он наследует подложку карточки, плашки или `details`. */
export const PAGE_GROUNDS = Object.freeze(['bg', 'surface', 'surface-2', 'banner-bg']);

const VAR_ONLY = /^var\(--([a-z0-9-]+)\)$/;
const SKIP_SELECTOR = /:disabled|\[disabled\]|::backdrop/;

/**
 * Сквозная проверка текста: каждое правило `color: var(--токен)` читается ≥ 4,5:1 на своём фоне (`background: var(--токен)` в том же правиле)
 * либо, если фон не задан, на КАЖДОМ из фонов страницы (`PAGE_GROUNDS`) — в обеих темах. Список пар `PAIRS` составлен вручную и неполон
 * (так пропущенное сочетание цвета волн на подложке 4,46:1 прошло бы незамеченным); эта проверка берёт сочетания из самих правил.
 * @param {string[]} css_texts тексты style.css и css/*.css
 * @param {{light: Record<string, string>, dark_auto: Record<string, string>}} tokens
 * @returns {{problems: string[], checked: number}}
 */
export function check_text_grounds(css_texts, tokens) {
  const problems = [];
  let checked = 0;
  for (const [i, text] of css_texts.entries()) {
    for (const rule of parse_rules(text)) {
      const fg = VAR_ONLY.exec(rule.decls.color ?? '')?.[1];
      if (fg === undefined || SKIP_SELECTOR.test(rule.selector)) continue;
      const own_bg = VAR_ONLY.exec(rule.decls.background ?? rule.decls['background-color'] ?? '')?.[1];
      for (const [theme, t] of [['light', tokens.light], ['dark', tokens.dark_auto]]) {
        for (const g of own_bg === undefined ? PAGE_GROUNDS : [own_bg]) {
          if (t[fg] === undefined || t[g] === undefined || parse_hex(t[fg]) === null || parse_hex(t[g]) === null) continue;
          checked += 1;
          const ratio = contrast_ratio(t[fg], t[g]);
          if (ratio < THRESHOLDS.text) problems.push(`${theme}: текст --${fg} на фоне --${g} — ${ratio.toFixed(2)}:1, нужно не меньше ${THRESHOLDS.text}:1 (css #${i}, «${rule.selector}»)`);
        }
      }
    }
  }
  return { problems, checked };
}

/**
 * Проверить стили.
 * @param {string} css текст style.css
 * @param {string[]} [other_css] тексты остальных CSS (проверяется, что цвета в них — только токены)
 * @returns {{themes: Record<'light'|'dark', {fg: string, bg: string, kind: string, ratio: number, min: number|null, ok: boolean, where: string}[]>, problems: string[], consistent: boolean}}
 */
export function check(css, other_css = []) {
  const t = theme_tokens(css);
  const problems = [];
  for (const [name, tokens] of Object.entries(t)) if (tokens === null) problems.push('не найден блок токенов: ' + name);
  if (problems.length > 0) return { themes: { light: [], dark: [] }, problems, consistent: false };
  const names = new Set([...Object.keys(t.light), ...Object.keys(t.dark_auto), ...Object.keys(t.dark_manual)]);
  for (const n of names) {
    for (const [theme, tokens] of Object.entries(t)) if (!(n in tokens)) problems.push(`токен --${n} не задан в блоке «${theme}»`);
  }
  let consistent = true;
  for (const n of Object.keys(t.dark_auto)) if (t.dark_auto[n] !== t.dark_manual[n]) { consistent = false; problems.push(`тёмная тема: --${n} различается (${t.dark_auto[n]} и ${t.dark_manual[n]})`); }
  const themes = { light: [], dark: [] };
  for (const [theme, tokens] of [['light', t.light], ['dark', t.dark_auto]]) {
    for (const p of PAIRS) {
      const a = tokens[p.fg];
      const b = tokens[p.bg];
      if (a === undefined || b === undefined || parse_hex(a) === null || parse_hex(b) === null) { problems.push(`${theme}: нет цвета для пары ${p.fg} / ${p.bg}`); continue; }
      const ratio = contrast_ratio(a, b);
      const min = p.kind === 'info' ? null : THRESHOLDS[p.kind];
      const ok = min === null || ratio >= min;
      themes[theme].push({ fg: p.fg, bg: p.bg, kind: p.kind, ratio: Math.round(ratio * 100) / 100, min, ok, where: p.where });
      if (!ok) problems.push(`${theme}: ${p.fg} на ${p.bg} — ${ratio.toFixed(2)}:1, нужно не меньше ${min}:1 (${p.where})`);
    }
  }
  // текст из правил CSS на всех фонах страницы (дополняет список пар)
  problems.push(...check_text_grounds([css, ...other_css], t).problems);
  // остальные стили не вводят свои цвета
  for (const [i, text] of other_css.entries()) {
    for (const r of parse_rules(text)) {
      for (const [prop, value] of Object.entries(r.decls)) {
        if (!/^(?:color|background(?:-color)?|border(?:-[a-z]+)?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|accent-color|caret-color|text-decoration-color)$/.test(prop)) continue;
        if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value) && r.selector !== 'dialog::backdrop') problems.push(`css #${i}: «${r.selector}» задаёт цвет не токеном (${prop}: ${value})`);
      }
    }
  }
  return { themes, problems, consistent };
}

function main(argv) {
  const css_path = argv.includes('--css') ? path.resolve(argv[argv.indexOf('--css') + 1] ?? '') : path.join(PROTO, 'demo', 'style.css');
  const dir = path.join(PROTO, 'demo', 'css');
  const others = argv.includes('--css') ? [] : fs.readdirSync(dir).filter((f) => f.endsWith('.css')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  const r = check(fs.readFileSync(css_path, 'utf8'), others);
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme === 'light' ? 'светлая' : 'тёмная'} тема ──`);
      for (const p of r.themes[theme]) console.log(`${p.ok ? 'ok ' : 'НЕТ'} ${p.ratio.toFixed(2).padStart(5)}:1  ${p.min === null ? 'справочно' : 'нужно ≥ ' + p.min}  ${p.fg} на ${p.bg} (${p.where})`);
    }
    for (const p of r.problems) console.error('ОШИБКА ' + p);
    console.log(r.problems.length === 0 ? 'контраст: все обязательные пары выше порога WCAG 2.2 AA в обеих темах' : 'контраст: есть нарушения (' + r.problems.length + ')');
  }
  return r.problems.length === 0 ? 0 : 1;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) process.exitCode = main(process.argv.slice(2));
