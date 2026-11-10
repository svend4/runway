// rate_chip.mjs — подпись курса и его возраста у каждой пересчитанной суммы (FP-16, REQ-077, REQ-079, REQ-112, ALG-08 A08.6, IDEA-50, UP-13).
//
// Курс — допущение пользователя: он введён вручную, у него есть дата. Поэтому у КАЖДОЙ суммы, которую движок пересчитал из чужой валюты в валюту решения
// (события с `rate_used` / `orig_amount_minor` в ленте, в «Почему», в карточках волн, в ответах ассистента, на листе для печати), показывается подпись:
// исходная сумма, сам курс «как введён», дата курса и возраст в днях («200,00 $ · курс 0,9250 от 2026-10-01 · возраст 3 дн.»). Возраст — от даты расчёта
// (`rate_status` движка), предел «устарел» — параметр `fx.stale_days` рабочей области (значение по умолчанию — в `vocab.json`, литерала в этом файле нет);
// курс старше предела получает пометку «курс устарел». Если курс взят из сценария курса (`fx_shock`), подпись это говорит.
// Числа и даты показываются в формате рабочей области (`ws.number_format`, REQ-112): десятичный знак курса, разделители сумм и стиль даты — одни и те же везде.
//
// Файл: чистая часть (подписи считаются из `ws` и результата `analyze`, без DOM и часов; проверяется в Node) и узлы (`h` из dom.mjs: только textContent).
// Тексты — из каталога `ratechip.*` (i18n/ratechip.mjs). Расчёт по введённым данным и правилам, не консультация.

import { rate_at, rate_status, flat_params, to_epoch_day, format_date, scenario_fx_shock, apply_shock } from '../engine/index.mjs';
import { liquidity_report } from '../engine/liquidity.mjs';
import { h } from './dom.mjs';
import { make_nf_fmt, resolve_number_format, format_input_amount, sanitize_number_format } from './number_format.mjs';

/** Сколько отдельных курсов перечисляет сводка (остальные не показываются: сводка — подпись, а не отчёт). */
export const MAX_USES = 8;

/**
 * Предел возраста курса в днях: параметр рабочей области `fx.stale_days`, прочитанный ТАК ЖЕ, как читает движок (`rate_warnings`): неотрицательное целое в пределах точного представления;
 * не задан или недопустим (строка, `null`, отрицательное, дробное) — `undefined`, и `rate_status` движка берёт значение по умолчанию (литерала в демо нет).
 * Одна функция на подпись суммы, плашку в шапке (`banner_texts.mjs`) и таблицу курсов (`form_fx.mjs`): плашка и пометка «курс устарел» не расходятся (FP-16, дефект D3).
 */
export function stale_limit(ws) {
  const v = flat_params(ws?.params)['fx.stale_days'];
  return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Курс «как введён»: точная десятичная дробь («0,9250»; знак дроби — из формата чисел рабочей области), иначе «≈ 0,925069» (шесть знаков).
 * @param {number} num
 * @param {number} den
 * @param {'ru'|'en'} lang
 * @param {any} [nf] `ws.number_format`
 * @returns {string}
 */
export function rate_digits(num, den, lang, nf) {
  const f = resolve_number_format(lang, nf);
  for (let k = 0; k <= 12; k++) {
    const p = 10 ** k;
    if (p % den === 0 && Number.isSafeInteger(num * (p / den))) return format_input_amount(num * (p / den), k, f, false);
  }
  const scaled = (BigInt(num) * 10n ** 6n * 2n + BigInt(den)) / (BigInt(den) * 2n); // половина вверх: курс положителен
  return '≈ ' + format_input_amount(Number(scaled), 6, f, false);
}

/** Дата курса в стиле пользователя: по умолчанию ISO (однозначно), иначе «дд.мм.гггг» или «мм/дд/гггг» (`number_format.date`). */
export function rate_date_text(nf, iso) {
  const style = sanitize_number_format(nf)?.date ?? 'auto';
  if (style === 'dmy') return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
  if (style === 'mdy') return iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4);
  return iso;
}

/**
 * Окружение подписей: язык интерфейса, формат чисел рабочей области, валюта решения, день расчёта.
 * @param {'ru'|'en'} lang
 * @param {object} ws рабочая область
 * @param {{decision_currency: string, as_of: number}} a результат `analyze` / контекст инструментов
 */
export function make_env(lang, ws, a) {
  return { lang, nf: ws?.number_format, dec: a.decision_currency, as_of: a.as_of, as_of_iso: format_date(a.as_of) };
}

/** Сумма в валюте `cur` в формате рабочей области («1.234,50 $» при формате «1.234,50»). */
export function money_in(env, cur, minor) {
  return make_nf_fmt(env.lang, cur, env.as_of_iso, env.nf).money(minor);
}

// ── подписи ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Подпись курса, по которому пересчитана сумма: сам курс, дата, возраст, «устарел», «обратная пара», «сценарий курса».
 * @param {object} ws
 * @param {{num: number, den: number, date: number|string}} used `rate_used` события (курс «валюта суммы → валюта решения», как применён)
 * @param {string} cur валюта суммы
 * @param {number} as_of день расчёта
 * @param {string} dec валюта решения
 * @returns {{cur: string, dec: string, num: number, den: number, date: string, age: number, stale: boolean, inverse: boolean, shocked: boolean}}
 */
export function signature_of(ws, used, cur, as_of, dec) {
  const day = to_epoch_day(used.date);
  const st = rate_status({ date: day }, as_of, stale_limit(ws));
  const base = rate_at(Array.isArray(ws?.rates) ? ws.rates : [], cur, dec, as_of);
  const inverse = base !== null && base.inverse === true;
  const shocked = base !== null && BigInt(base.num) * BigInt(used.den) !== BigInt(base.den) * BigInt(used.num);
  return { cur, dec, num: used.num, den: used.den, date: format_date(day), age: st.age, stale: st.stale, inverse, shocked };
}

/**
 * Подпись пересчёта события: исходная сумма и валюта, сумма в валюте решения и подпись курса; `null`, если событие не пересчитывалось.
 * @param {object} ws
 * @param {{decision_currency: string, as_of: number}} a
 * @param {object} e событие расчёта (`a.events[mode][i]`)
 */
export function event_fx(ws, a, e) {
  const used = e?.rate_used;
  if (used === null || used === undefined || typeof e.orig_currency !== 'string' || !Number.isSafeInteger(e.orig_amount_minor)) return null;
  if (e.orig_currency === a.decision_currency) return null;
  return { cur: e.orig_currency, orig_minor: e.orig_amount_minor, conv_minor: e.amount_minor, sig: signature_of(ws, used, e.orig_currency, a.as_of, a.decision_currency) };
}

/** Пересчитанные события списка (`id → подпись`), в порядке списка. */
export function fx_by_event(ws, a, events) {
  const out = new Map();
  for (const e of events ?? []) {
    const fx = event_fx(ws, a, e);
    if (fx !== null) out.set(e.cash_event_id, fx);
  }
  return out;
}

/**
 * Подписи одинаковых пересчётов без повторов: события группы (например, «Подписка × 4») с одной и той же исходной суммой, курсом и датой курса склеиваются
 * в одну подпись с числом `count`; при разных суммах или курсах в группе остаются только различные (FP-16, дефект D2).
 * @param {{cur: string, orig_minor: number, sig: {num: number, den: number, date: string}}[]} list
 * @returns {{cur: string, orig_minor: number, conv_minor?: number, sig: object, count: number}[]}
 */
export function dedupe_fx(list) {
  const seen = new Map();
  for (const x of list ?? []) {
    const key = x.cur + '|' + x.orig_minor + '|' + x.sig.num + '/' + x.sig.den + '|' + x.sig.date;
    const hit = seen.get(key);
    if (hit === undefined) seen.set(key, { ...x, count: 1 });
    else hit.count += 1;
  }
  return [...seen.values()];
}

/**
 * Остатки на счетах в чужой валюте, которые движок пересчитал по курсу (FP-16, дефект D1: остаток без событий тоже пересчитан по курсу и должен быть подписан):
 * `operating` — опорный остаток «Остаток на …» (`opening_state`: ненулевой остаток счёта, сценарий курса `fx_shock` действует и на него), `stock` — вклад
 * накопительного счёта или актива в «запас» (`liquid_value`, ненулевой; без сценария курса, как в `liquidity_report`). Нулевой остаток курса не просит (Q-16)
 * и подписи не получает; счёт без курса пары (ошибка) пропускается — его отказ называет `E_NO_RATE`.
 * @param {object} ws
 * @param {{decision_currency: string, as_of: number}} a результат `analyze` / контекст инструментов
 * @param {{ops?: object[]}|null} [scenario] сценарий модели (`model.scenario`): его сдвиг курса действует на остатки `operating`
 * @returns {{kind: 'operating'|'stock', account_id: string, cur: string, orig_minor: number, sig: object}[]}
 */
export function balance_fx(ws, a, scenario) {
  let rep;
  try { rep = liquidity_report(ws, a.as_of); } catch { return []; }
  const shock = scenario_fx_shock(scenario ?? null);
  const rates = Array.isArray(ws?.rates) ? ws.rates : [];
  const out = [];
  for (const r of rep.accounts) {
    if (r.currency === a.decision_currency || r.error !== null || !Number.isSafeInteger(r.balance_minor) || r.balance_minor === 0) continue;
    const operating = r.liquidity === 'operating';
    if (!operating && (!Number.isSafeInteger(r.value_minor) || r.value_minor === 0)) continue; // в запас вклада нет (asset при 0 bp, долг) — пересчитанной суммы нет
    const base = rate_at(rates, r.currency, a.decision_currency, a.as_of);
    if (base === null) continue;
    let used = { num: base.num, den: base.den, date: base.date };
    const s = operating && Object.hasOwn(shock, r.currency) ? shock[r.currency] : undefined;
    if (s !== undefined && s !== null) {
      try { used = apply_shock(base, s); } catch { /* недопустимый сдвиг уже отказал расчёту; подпись остаётся по курсу пары */ }
    }
    out.push({ kind: operating ? 'operating' : 'stock', account_id: String(r.account_id), cur: r.currency, orig_minor: r.balance_minor, sig: signature_of(ws, used, r.currency, a.as_of, a.decision_currency) });
  }
  return out;
}

/**
 * Курсы, по которым пересчитан расчёт (оба режима), без повторов; для сводки под ответом ассистента, на листе для печати, «Покупке», «В магазине» и в v0.
 * Это курсы событий (`rate_used`) И остатков счетов в чужой валюте (опорный остаток и «запас», `balance_fx`): остаток без единого события тоже назван.
 * @param {object} ws
 * @param {{decision_currency: string, as_of: number, events?: object}} a
 * @param {{ops?: object[]}|null} [scenario] сценарий модели (сдвиг курса действует на остатки `operating`)
 * @returns {{cur: string, dec: string, num: number, den: number, date: string, age: number, stale: boolean, inverse: boolean, shocked: boolean}[]}
 */
export function rate_uses(ws, a, scenario) {
  const seen = new Map();
  const add = (sig) => {
    const key = sig.cur + '|' + sig.num + '/' + sig.den + '|' + sig.date;
    if (!seen.has(key)) seen.set(key, sig);
  };
  for (const mode of ['plan', 'worse']) {
    for (const e of a.events?.[mode] ?? []) {
      const fx = event_fx(ws, a, e);
      if (fx !== null) add(fx.sig);
    }
  }
  for (const b of balance_fx(ws, a, scenario)) add(b.sig);
  return [...seen.values()].sort((x, y) => (x.cur < y.cur ? -1 : x.cur > y.cur ? 1 : x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/** Текст подписи курса: «курс 0,9250 от 2026-10-04 · возраст 3 дн.» (+ «· курс устарел», «· с учётом сценария курса»). */
export function sign_text(tr, env, sig) {
  const base = tr(sig.inverse ? 'ratechip.sign_inverse' : 'ratechip.sign', { rate: rate_digits(sig.num, sig.den, env.lang, env.nf), date: rate_date_text(env.nf, sig.date), n: sig.age });
  return base + (sig.stale ? ' · ' + tr('ratechip.stale_tag') : '') + (sig.shocked ? ' · ' + tr('ratechip.shocked') : '');
}

/** Строка у суммы: «200,00 $ · курс 0,9250 от 2026-10-01 · возраст 3 дн.». */
export function row_text(tr, env, fx) {
  return tr('ratechip.row', { orig: money_in(env, fx.cur, fx.orig_minor), sign: sign_text(tr, env, fx.sig) });
}

/** Строка карточки волны: «Доллары: 200,00 $ → 185,00 € · курс 0,9250 от 2026-10-01 · возраст 3 дн.». */
export function wave_line_text(tr, env, name, fx) {
  return tr('ratechip.wave_line', { name, orig: money_in(env, fx.cur, fx.orig_minor), conv: money_in(env, env.dec, fx.conv_minor), sign: sign_text(tr, env, fx.sig) });
}

/** Перечень курсов расчёта одной строкой: «USD → EUR: курс 0,9250 от … · возраст 3 дн.; GBP → EUR: …». Пусто, если пересчётов нет. */
export function uses_list_text(tr, env, uses) {
  return uses.slice(0, MAX_USES).map((u) => tr('ratechip.note_item', { pair: u.cur + ' → ' + u.dec, sign: sign_text(tr, env, u) })).join('; ');
}

/** Примечание под ответом ассистента: «Суммы в иностранной валюте пересчитаны по введённым курсам — …». Пусто, если пересчётов нет. */
export function answer_note_text(tr, env, uses) {
  return uses.length === 0 ? '' : tr('ratechip.answer_note', { list: uses_list_text(tr, env, uses) });
}

/** Примечание листа для печати: те же курсы, но с оговоркой про валюту решения. Пусто, если пересчётов нет. */
export function report_note_text(tr, env, uses) {
  return uses.length === 0 ? '' : tr('ratechip.report_note', { list: uses_list_text(tr, env, uses) });
}

/**
 * Остатки `operating`-счетов в чужой валюте с подписью курса (для «Остаток на …» в шапке и шва ленты): остатки счетов с одним и тем же курсом складываются,
 * чтобы два долларовых счёта не давали две одинаковые подписи. Пусто, если чужих остатков нет.
 * @returns {{cur: string, orig_minor: number, sig: object}[]}
 */
export function balance_groups(balances) {
  const groups = new Map();
  for (const b of balances ?? []) {
    if (b.kind !== 'operating') continue;
    const key = b.cur + '|' + b.sig.num + '/' + b.sig.den + '|' + b.sig.date;
    const hit = groups.get(key);
    if (hit === undefined) groups.set(key, { cur: b.cur, orig_minor: b.orig_minor, sig: b.sig });
    else if (Number.isSafeInteger(hit.orig_minor + b.orig_minor)) hit.orig_minor += b.orig_minor;
  }
  return [...groups.values()];
}

/** Примечание к «Остатку на …»: «Остаток пересчитан по введённым курсам: 5 000,00 $ · курс 0,9250 от … · возраст 3 дн.». Пусто, если чужих остатков нет. */
export function balance_note_text(tr, env, balances) {
  const groups = balance_groups(balances);
  return groups.length === 0 ? '' : tr('ratechip.balance_note', { list: groups.slice(0, MAX_USES).map((g) => row_text(tr, env, g)).join('; ') });
}

// ── узлы ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Подпись у суммы (мелкий текст в строке таблицы или списка). Устаревший курс получает класс `rate-stale`: смысл — словами, не цветом.
 * `with_count` дописывает « × N» к склеенной подписи (`dedupe_fx`): нужно, когда в строке несколько разных подписей и число платежей по каждой не видно из названия.
 */
export function chip_node(tr, env, fx, with_count = false) {
  const times = with_count && Number.isSafeInteger(fx.count) && fx.count > 1 ? ' × ' + fx.count : '';
  return h('small', { class: 'rate-chip' + (fx.sig.stale ? ' rate-stale' : ''), text: row_text(tr, env, fx) + times });
}

/** Абзац-примечание (ответ ассистента, лист для печати): `null`, если текста нет. */
export function note_node(text, cls = 'muted rate-note') {
  return text === '' ? null : h('p', { class: cls, text });
}
