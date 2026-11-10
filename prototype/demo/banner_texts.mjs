// banner_texts.mjs — тексты плашек и сообщений о курсе (FP-16, REQ-079, REQ-077): «курс устарел» с валютой и возрастом, «нет курса» с парой и путём к вводу.
//
// Плашка `W_RATE_STALE` в шапке называет пару валют, возраст курса в днях, дату курса и место, где курс обновляется. Сообщение
// `E_NO_RATE` называет пару и ведёт на экран «Формы данных» → «Курсы и обмен» (а не «в настройках»: настроек курса нет). Тексты — из каталога
// `ratechip.*`; названия экрана и раздела берутся из каталога форм (`forms.nav`, `forms.tab_fx`), поэтому не расходятся с интерфейсом.
// Пара валют попадает в текст только если это коды валют (проверка по шаблону), а не произвольный текст из файла или ввода.
// Чистый модуль: без DOM и часов, `tr` передаёт вызывающий. Расчёт по введённым данным и правилам, не консультация.

import { rate_at, rate_status, format_date } from '../engine/index.mjs';
import { stale_limit, rate_date_text } from './rate_chip.mjs';

const CODE_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** Место ввода курса: «Формы данных → Курсы и обмен» (названия — из каталога форм). */
export function rates_route(tr) {
  return tr('forms.nav') + ' → ' + tr('forms.tab_fx');
}

/**
 * Строка каталога или `null`, если её нет: `t()` на неизвестный ключ возвращает сам ключ. Строки `ratechip.*` и `forms.*` живут в пакетах (FP-16, FP-08); если пакет не
 * загрузился, на экран не должен попасть сырой ключ — вызывающий берёт общий текст ядра (`warn.W_RATE_STALE`, `err.E_NO_RATE`), в котором путь к курсам написан целиком.
 */
function known(tr, key, params) {
  const s = tr(key, params);
  return typeof s === 'string' && s !== key ? s : null;
}

/** Каталоги пакетов, на которые опираются тексты этого файла, загружены (название раздела и вкладки курсов не вернулись сырыми ключами). */
function route_known(tr) {
  return known(tr, 'forms.nav') !== null && known(tr, 'forms.tab_fx') !== null;
}

/**
 * Пара валют из контекста отказа: `{pair: 'USD/EUR'}` (движок), `{currency, decision_currency}` (правки `ws_edit`) или `{from, to}` (перевод между счетами в разных
 * валютах). Только коды валют; иначе `null`. Пользовательский текст в сообщение не попадает.
 * @param {any} c `error.ctx`
 * @returns {string|null} «USD → EUR»
 */
export function pair_of(c) {
  if (c === null || typeof c !== 'object') return null;
  const m = typeof c.pair === 'string' ? /^([A-Z][A-Z0-9]{1,9})\/([A-Z][A-Z0-9]{1,9})$/.exec(c.pair) : null;
  if (m !== null) return m[1] + ' → ' + m[2];
  const [a, b] = [c.currency ?? c.from, c.decision_currency ?? c.to];
  return typeof a === 'string' && typeof b === 'string' && CODE_RE.test(a) && CODE_RE.test(b) ? a + ' → ' + b : null;
}

/** Сообщение «нет курса»: называет пару (если известна) и ведёт на «Формы данных» → «Курсы и обмен». */
export function no_rate_text(tr, c) {
  const pair = pair_of(c);
  const where = rates_route(tr);
  const own = route_known(tr) ? (pair === null ? known(tr, 'ratechip.err_no_rate_any', { where }) : known(tr, 'ratechip.err_no_rate', { pair, where })) : null;
  return own ?? tr('err.E_NO_RATE'); // пакет не загрузился — общий текст ядра, не сырой ключ
}

/**
 * Плашка `W_RATE_STALE` с валютой и возрастом: «Курс USD → EUR не обновлялся 64 дн.: суммы в USD пересчитаны по курсу от 2026-08-01. Обновите курс: …».
 * Возраст — от даты расчёта до даты курса пары (`rate_status` движка). `null`, если курс пары не найден или предупреждение чужое — тогда показывается общий текст.
 * @param {(key: string, params?: object) => string} tr
 * @param {object} ws рабочая область
 * @param {{decision_currency: string, as_of: number}} a
 * @param {{code: string, currency?: string}} w предупреждение движка
 * @param {any} [nf] `ws.number_format` (стиль даты курса)
 * @returns {string|null}
 */
export function rate_stale_text(tr, ws, a, w, nf = ws?.number_format) {
  if (w?.code !== 'W_RATE_STALE' || typeof w.currency !== 'string' || !CODE_RE.test(w.currency)) return null;
  const r = rate_at(Array.isArray(ws?.rates) ? ws.rates : [], w.currency, a.decision_currency, a.as_of);
  if (r === null) return null;
  const st = rate_status({ date: r.date }, a.as_of, stale_limit(ws));
  if (!route_known(tr)) return null;
  return known(tr, 'ratechip.warn_stale_n', { pair: w.currency + ' → ' + a.decision_currency, n: st.age, cur: w.currency, date: rate_date_text(nf, format_date(r.date)), where: rates_route(tr) }); // `null` — общий текст предупреждения
}
