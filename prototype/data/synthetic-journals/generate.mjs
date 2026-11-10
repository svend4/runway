// generate.mjs — детерминированный генератор СИНТЕТИЧЕСКИХ журналов для backtest и гейта релиза (ALG-13, REQ-176, TST-55).
// ВАЖНО: это не данные пользователей. Реальных журналов добровольцев (≥ 10, REQ-176) пока нет; здесь — прототипная демонстрация
// метрики: журналы строятся из параметров и счётчикового хэша `u01(seed, ключ, номер)` (без состояния и без часов), поэтому при тех же
// параметрах результат побайтно один и тот же на любой платформе. Параметры корпусов подобраны так, чтобы показать оба исхода гейта
// (проходит / не проходит); это свойство тестового набора, а не свидетельство о качестве прогноза на реальных людях.
// Это тестовая оснастка: файл лежит в data/, а не в engine/, и может импортировать модули движка (ledger, dates, montecarlo).
//
// Что в журнале (тип записи → смысл): account.opened, calendar.set, params.set, rule.set ×4 (аренда, ЖКХ, связь — обязательства;
// продукты — оценка), stream.set (почасовой доход как у G-001: 30,00 €/ч, часы 4800/5580/6600 мин, выплата через 5 дней после конца месяца),
// при `tax_bp > 0` — taxrule.set, reserve.set и по каждому поступлению allocation.recorded, раз в квартал платёж налога и ручное освобождение резерва (отрицательная аллокация, C-059);
// tx.posted — факты в день события (плановые — в плановую дату и в допуске суммы, доход — с задержкой клиента, связанный записью match.set
// с плановым вхождением по `occ_key`), редкие «произвольные» покупки без флагов обязательства/оценки (они и есть пробы backtest),
// anchor.set — сверка остатка раз в `anchor_every` дней. Каждая запись введена в день события (`recorded_at`), задним числом — ничего.

import { make_event, canon, sha256 } from '../../engine/ledger.mjs';
import { parse_date, format_date, civil_from_days, days_from_civil, days_in_month, dow } from '../../engine/dates.mjs';
import { u01 } from '../../engine/montecarlo.mjs';
import { round_div } from '../../engine/money.mjs';

/**
 * @typedef {object} JournalSpec
 * @property {string} id идентификатор журнала (префикс идентификаторов записей)
 * @property {number} seed uint32
 * @property {string} [start] первый день, IsoDate (по умолчанию 2026-01-01)
 * @property {string} [end] последний день (по умолчанию 2026-09-30)
 * @property {number} opening_minor остаток на `start` (якорь)
 * @property {number} buffer_minor буфер B
 * @property {number} cost_pct масштаб расходов, % (100 — как G-001)
 * @property {number} rate_minor ставка за час, minor
 * @property {number[]} lag_profile задержки клиента (дни), бутстрап по номеру выплаты
 * @property {number} [disc_per_month] «произвольных» покупок в месяц (по умолчанию 2)
 * @property {number[]} [disc_small] границы малой покупки [lo, hi], minor
 * @property {number[]} [disc_big] границы крупной покупки [lo, hi], minor
 * @property {number} [disc_big_pct] доля крупных покупок, % (по умолчанию 25)
 * @property {number} [tax_bp] ставка налогового конверта, bp (0 — без резервов)
 * @property {number} [anchor_every] сверка остатка раз в N дней (по умолчанию 7)
 */

const DEFAULTS = Object.freeze({
  start: '2026-01-01',
  end: '2026-09-30',
  disc_per_month: 2,
  disc_small: [3200, 8000],
  disc_big: [15000, 45000],
  disc_big_pct: 25,
  tax_bp: 0,
  anchor_every: 7,
});

const ACC = 'acc_main';
const CUR = 'EUR';

/** Целое в `[lo, hi]` по `u ∈ [0, 1)`. */
function between(u, lo, hi) {
  return lo + Math.floor(u * (hi - lo + 1));
}

/** Следующий рабочий день (сб/вс — выходные) на дату или после. */
function next_business(d) {
  let x = d;
  while (dow(x) === 0 || dow(x) === 6) x += 1;
  return x;
}

/** Последний день месяца, в котором лежит `d`. */
function month_end_of(d) {
  const [y, m] = civil_from_days(d);
  return days_from_civil(y, m, days_in_month(y, m));
}

/**
 * Журнал по параметрам: массив записей `ledger.make_event` (`seq` 1…n по порядку, `recorded_at` = день события, 12:00:00Z).
 * @param {JournalSpec} spec
 * @returns {object[]}
 */
export function make_journal(spec) {
  const S = { ...DEFAULTS, ...spec };
  const start = parse_date(S.start);
  const end = parse_date(S.end);
  const cost = (x) => round_div(x * S.cost_pct, 100);
  const events = [];
  let seq = 0;
  let cur_day = start;
  let balance = S.opening_minor;
  let pending_tax = 0; // аллокации налога, накопленные с прошлого платежа
  const emit = (type, payload, extra = {}) => {
    seq += 1;
    const ev = make_event(type, payload, {
      event_id: `${S.id}-e${String(seq).padStart(5, '0')}`,
      seq,
      recorded_at: `${format_date(cur_day)}T12:00:00Z`,
      ...extra,
    });
    events.push(ev);
    return ev;
  };
  const tx = (date, amount_minor, kind, tag, flags = {}) => {
    const ev = emit('tx.posted', { account_id: ACC, date: format_date(date), amount_minor, currency: CUR, kind, tag, ...flags }, { entity_id: `${S.id}-tx${String(seq + 1).padStart(5, '0')}` });
    balance += amount_minor;
    return ev;
  };

  // ── настройка рабочей области (день start) ────────────────────────────────────────────────────────────────────────────
  emit('account.opened', { account_id: ACC, name: 'Основной счёт', kind: 'bank', liquidity: 'operating', currency: CUR, exponent: 2, liquidity_bp: 0, opened_on: format_date(start) });
  emit('calendar.set', { calendar_id: 'cal-main', name: 'Суббота и воскресенье', weekend_dows: [0, 6], holidays: [] });
  emit('params.set', { buffer_minor: S.buffer_minor, 'worse.income_delay_days': 14, headline_mode: 'worse' }, { entity_id: 'params' });
  const base_rule = { account_id: ACC, kind: 'expense', currency: CUR, freq: 'M', interval: 1, month_end: 'clamp', weekend: 'next', calendar_id: null, exdates: [] };
  const rent = cost(90000);
  const util = cost(12000);
  const phone = cost(2500);
  const groc = cost(10000);
  emit('rule.set', { ...base_rule, rule_id: 'R-RENT', name: 'Аренда', amount: { exp_minor: -rent }, by_monthday: [25], start_date: S.start, is_obligation: true, is_estimate: false, tag: 'аренда' });
  emit('rule.set', { ...base_rule, rule_id: 'R-UTIL', name: 'ЖКХ', amount: { exp_minor: -util }, by_monthday: [25], start_date: S.start, is_obligation: true, is_estimate: false, tag: 'жкх' });
  emit('rule.set', { ...base_rule, rule_id: 'R-PHONE', name: 'Связь', amount: { exp_minor: -phone }, by_monthday: [9], start_date: S.start, is_obligation: true, is_estimate: false, tag: 'связь' });
  emit('rule.set', { ...base_rule, rule_id: 'R-GROC', name: 'Продукты', amount: { exp_minor: -groc }, freq: 'W', by_weekday: [6], start_date: S.start, weekend: 'keep', is_obligation: false, is_estimate: true, tag: 'продукты' });
  const stream = {
    stream_id: 'S-HOURLY', account_id: ACC, name: 'Почасовая работа', currency: CUR, rate_minor: S.rate_minor, period: 'month', cutoff: { kind: 'month_end' },
    pay_lag_days: 5, weekend: 'next', calendar_id: 'cal-main', hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 }, pace_minutes_per_day: 180, bonus: [],
  };
  emit('stream.set', stream);
  if (S.tax_bp > 0) {
    emit('taxrule.set', {
      tax_rule_id: 'TR-TAX', version: 1, name: 'Налоговый конверт (правило пользователя, не консультация)', kind: 'percent_of_income', rate_bp: S.tax_bp, base: 'gross',
      applies_to: { stream_ids: ['S-HOURLY'], tags: [] }, valid_from: '2026-01-01', valid_to: null, rounding: 'half_even', reserve_id: 'RES-TAX',
    });
    emit('reserve.set', { reserve_id: 'RES-TAX', kind: 'tax', name: 'Налоговый конверт', currency: CUR, funded_start_minor: 0, funded_as_of: S.start, tax_rule_id: 'TR-TAX', backed_by_account_id: null });
  }

  // ── расписания дней ───────────────────────────────────────────────────────────────────────────────────────────────────
  /** day → список действий дня, в порядке добавления. */
  const plan = new Map();
  const at = (d, f) => { if (d >= start && d <= end) { if (!plan.has(d)) plan.set(d, []); plan.get(d).push(f); } };

  const [y0, m0] = civil_from_days(start);
  const [y1, m1] = civil_from_days(end);
  const month_count = (y1 - y0) * 12 + (m1 - m0) + 1;
  for (let k = 0; k < month_count; k++) {
    const y = y0 + Math.floor((m0 - 1 + k) / 12);
    const m = ((m0 - 1 + k) % 12) + 1;
    at(next_business(days_from_civil(y, m, 25)), () => { tx(cur_day, -rent, 'expense', 'аренда', { is_obligation: true }); tx(cur_day, -util, 'expense', 'жкх', { is_obligation: true }); });
    at(next_business(days_from_civil(y, m, 9)), () => { tx(cur_day, -phone, 'expense', 'связь', { is_obligation: true }); });
  }
  let sat = start;
  while (dow(sat) !== 6) sat += 1;
  for (let i = 0; sat <= end; sat += 7, i++) {
    const wk = i;
    at(sat, () => {
      const noise = between(u01(S.seed, 'groc', wk), -4, 4); // ±4 % — внутри допуска сопоставления 5 %
      tx(cur_day, -round_div(groc * (100 + noise), 100), 'expense', 'продукты', { is_estimate: true });
    });
  }
  // доход: выплата за каждый месяц; плановая номинальная дата — конец месяца + 5 дней (ключ occ_key), фактическая — позже на лаг клиента
  const first_income_period_end = month_end_of(days_from_civil(y0, m0, 1) - 1); // выплата за месяц до start приходит в январе
  let pe = first_income_period_end;
  for (let j = 0; ; j++) {
    const nominal = pe + 5;
    if (nominal > end) break;
    const lag = S.lag_profile[between(u01(S.seed, 'lag', j), 0, S.lag_profile.length - 1)];
    const minutes = 4800 + Math.floor(((6600 - 4800) * (u01(S.seed, 'hrs_a', j) + u01(S.seed, 'hrs_b', j))) / 2); // треугольное в [min, max]
    const gross = round_div(S.rate_minor * minutes, 60);
    const arrive = next_business(next_business(nominal) + lag);
    const occ_key = `S-HOURLY@${format_date(nominal)}`;
    at(arrive, () => {
      const f = tx(cur_day, gross, 'income', 'Почасовая работа', { stream_id: 'S-HOURLY' });
      emit('match.set', { fact_event_id: f.event_id, plan_ref: occ_key }); // пользователь подтвердил: это выплата по плану (лаг > окна 3 дня)
      if (S.tax_bp > 0) {
        const a = round_div(gross * S.tax_bp, 10000);
        pending_tax += a;
        emit('allocation.recorded', { allocation_id: `tax:TR-TAX@${f.event_id}`, reserve_id: 'RES-TAX', date: format_date(cur_day), amount_minor: a, source: 'income', source_event_id: f.event_id });
      }
    });
    const [py, pm] = civil_from_days(pe + 1);
    pe = month_end_of(days_from_civil(py, pm, 1));
  }
  if (S.tax_bp > 0) {
    for (const [mm, dd] of [[4, 15], [7, 15], [10, 15]]) {
      at(next_business(days_from_civil(y0, mm, dd)), () => {
        if (pending_tax > 0) {
          // платёж с операционного счёта + ручное освобождение остатка резерва (C-059): без привязки платежа к резерву высвобождение не задваивается
          tx(cur_day, -pending_tax, 'expense', 'налог', { is_obligation: true });
          emit('allocation.recorded', { allocation_id: `rel:${S.id}@${format_date(cur_day)}`, reserve_id: 'RES-TAX', date: format_date(cur_day), amount_minor: -pending_tax, source: 'manual' });
          pending_tax = 0;
        }
      });
    }
  }
  // произвольные покупки: без флагов обязательства/оценки; суммы вне полос ±10 % вокруг плановых сумм (чтобы не цеплялись к плану)
  for (let k = 0; k < month_count; k++) {
    const y = y0 + Math.floor((m0 - 1 + k) / 12);
    const m = ((m0 - 1 + k) % 12) + 1;
    for (let i = 0; i < S.disc_per_month; i++) {
      const key = k * 100 + i;
      const day = days_from_civil(y, m, between(u01(S.seed, 'disc_day', key), 1, 28));
      const big = u01(S.seed, 'disc_kind', key) * 100 < S.disc_big_pct;
      const [lo, hi] = big ? S.disc_big : S.disc_small;
      const amount = between(u01(S.seed, 'disc_amt', key), lo, hi);
      at(day, () => { tx(cur_day, -amount, 'expense', big ? 'крупная покупка' : 'покупка'); });
    }
  }

  // ── ход по дням ───────────────────────────────────────────────────────────────────────────────────────────────────────
  cur_day = start;
  emit('anchor.set', { anchor_id: `anc-${S.id}-${format_date(start)}`, account_id: ACC, date: format_date(start), amount_minor: S.opening_minor });
  for (let d = start + 1; d <= end; d++) {
    cur_day = d;
    for (const f of plan.get(d) ?? []) f();
    if ((d - start) % S.anchor_every === 0) emit('anchor.set', { anchor_id: `anc-${S.id}-${format_date(d)}`, account_id: ACC, date: format_date(d), amount_minor: balance });
  }
  return events;
}

/** Хэш журнала для замка воспроизводимости: `sha256(canon(записи))`. */
export function journal_hash(events) {
  return sha256(canon(events));
}

// ── корпусы ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PROMPT = [0, 0, 1, 2, 3];
const TYPICAL = [0, 2, 3, 5, 7, 9, 12];
const SLOW = [3, 7, 10, 14, 18, 25];

/**
 * Корпус «обычные фрилансеры»: 12 журналов с разным остатком, расходами, налоговым конвертом и скоростью оплаты клиентом
 * (быстро / обычно / медленно, задержки до 25 дней). Состав зафиксирован как демонстрация прохождения гейта на синтетических данных.
 * @returns {JournalSpec[]}
 */
export function regular_corpus() {
  const profiles = [PROMPT, TYPICAL, SLOW];
  return Array.from({ length: 12 }, (_, i) => ({
    id: `reg${String(i + 1).padStart(2, '0')}`,
    seed: 1000 + 37 * i,
    opening_minor: [120000, 185000, 250000][(i * 2 + 1) % 3],
    buffer_minor: 50000,
    cost_pct: [140, 150, 160][i % 3],
    rate_minor: 2800 + 100 * (i % 6),
    lag_profile: profiles[(i + (i >> 2)) % 3],
    tax_bp: (i % 2) * 2000,
  }));
}

/**
 * Корпус «стресс»: 10 журналов, где клиент иногда платит на 30–60 дней позже (дальше, чем режим worse, 14 дней), а расходы высоки.
 * Демонстрирует провал гейта по FRR: вердикт «выдерживает» нередко сменяется пробоем буфера.
 * @returns {JournalSpec[]}
 */
export function stress_corpus() {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `str${String(i + 1).padStart(2, '0')}`,
    seed: 5000 + 53 * i,
    opening_minor: [200000, 260000, 320000][i % 3],
    buffer_minor: 50000,
    cost_pct: [150, 165, 180][i % 3],
    rate_minor: 2600 + 100 * (i % 4),
    lag_profile: [0, 1, 2, 3, 30, 45, 60],
    tax_bp: i % 4 === 0 ? 2000 : 0,
  }));
}
