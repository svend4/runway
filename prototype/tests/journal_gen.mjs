// journal_gen.mjs — генератор случайных журналов для тестов журнала (FP-01): все виды записей, повторные записи тех же сущностей, откаты и замены,
// ссылающиеся на любую раннюю запись. Только для тестов (make_rng из helpers.mjs).
//
// FP-24 (REQ-171, REQ-172, REQ-158): ниже, аддитивно, общий генератор ВАЛИДНЫХ журналов и рабочих областей на mulberry32 (без Math.random и часов):
// `gen_case(seed, opts)` — журнал с счетами, якорями, фактами, правилами, потоком часов, разовыми планами, налоговым конвертом и накоплениями, повторными правками
// (`supersedes_id`), откатами и откатами откатов; `ws_of(events)` — рабочая область (свёртка журнала); `case_seed(base, i)` — seed i-го журнала серии.
// Те же функции питают property-тесты (properties.test.mjs), замок вывода движка (engine_lock.test.mjs, tools/make_engine_lock.mjs) и тесты малых
// журналов (small_journals.test.mjs: пустой, одно событие, дубли дат, значения ±(2^53−1)). Прежняя функция `random_journal` не менялась.

import { make_event, effective_events, reduce } from '../engine/index.mjs';
import { plan_window_start, plan_occurrences } from '../engine/mc_inputs.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { make_rng } from './helpers.mjs';

/** Случайный журнал из `n` записей: все виды записей, повторные записи тех же сущностей, откаты и замены, ссылающиеся на ЛЮБУЮ раннюю запись. */
export function random_journal(rng, n) {
  const events = [];
  const mk = (type, payload, extra = {}) => {
    const seq = events.length + 1;
    const e = make_event(type, payload, { event_id: 'e' + seq, seq, recorded_at: '2026-10-04T08:00:00Z', ...extra });
    events.push(e);
    return e;
  };
  mk('account.opened', { account_id: 'a1', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  const refs = () => (events.length < 2 ? undefined : events[rng.int(1, events.length - 1)]); // кроме account.opened: журнал без счёта не сворачивается
  const pool = (p, k) => p + rng.int(1, k);
  while (events.length < n) {
    const kind = rng.int(0, 22);
    const back = rng.int(0, 6) === 0 && events.length > 1 ? { supersedes_id: refs().event_id } : {};
    switch (kind) {
      case 0: case 1: case 2: {
        const id = pool('tx', 6);
        mk('tx.posted', { account_id: 'a1', date: '2026-09-' + String(rng.int(1, 28)).padStart(2, '0'), amount_minor: rng.int(-9000, 9000), currency: 'EUR', tag: rng.pick(['еда', 'кофе', '=cmd', 'Café']) }, { entity_id: id, ...back });
        break;
      }
      case 3: mk('anchor.set', { anchor_id: pool('anc', 3), account_id: 'a1', date: '2026-09-15', amount_minor: rng.int(0, 500000) }, back); break;
      case 4: mk('rule.set', { rule_id: pool('R', 4), version: rng.int(1, 3), amount: { exp_minor: -rng.int(1, 9000) }, tag: 'x' }, back); break;
      case 5: mk('plan.set', { plan_id: pool('P', 3), date: '2026-10-10', amount_minor: -rng.int(1, 9000) }, back); break;
      case 6: mk('params.set', { buffer_minor: rng.int(0, 90000), 'match.tol_bp': rng.int(0, 900) }, { entity_id: 'ws1' }); break;
      case 7: mk('taxrule.set', { tax_rule_id: pool('TR', 2), version: rng.int(1, 4), rate_bp: rng.int(0, 5000) }, back); break;
      case 8: mk('wave_override.set', { override_id: pool('w', 5), action: 'pin', event_ids: ['x'] }, back); break;
      case 9: {
        const tx = events.filter((e) => e.type === 'tx.posted');
        if (tx.length > 0) mk('match.set', { fact_event_id: rng.bool() ? rng.pick(tx).event_id : rng.pick(tx).entity_id, ...(rng.bool() ? { plan_ref: 'R1@2026-09-10' } : { no_plan: true }) });
        break;
      }
      case 10: mk('stream.set', { stream_id: pool('S', 2), rate_minor: rng.int(1, 9000) }, back); break;
      case 11: mk('reserve.set', { reserve_id: pool('RES', 2), kind: 'tax', funded_start_minor: rng.int(0, 900) }, back); break;
      case 12: mk('allocation.recorded', { allocation_id: pool('al', 4), reserve_id: 'RES1', amount_minor: rng.int(1, 500) }, back); break;
      case 13: mk('fx.set', { fx_id: pool('fx', 3), base: 'USD', quote: 'EUR', num: rng.int(1, 99), den: 100 }, back); break;
      case 14: mk('scenario.set', { scenario_id: pool('sc', 3), name: 'S', ops: [] }, back); break;
      case 15: mk('counterparty.set', { counterparty_id: pool('cp', 3), name: 'Клиент' }, back); break;
      case 16: mk('override.set', { rule_id: pool('R', 4), nominal_date: '2026-10-0' + rng.int(1, 9), action: 'skip' }, back); break;
      case 17: mk('import.started', { batch_id: pool('b', 2), counts: { recognized: rng.int(0, 9) } }); break;
      case 18: mk('import.rolled_back', { batch_id: pool('b', 2) }); break;
      case 19: mk('consent.granted', { scope: 'x', version: rng.int(1, 3) }, { entity_id: pool('c', 2) }); break;
      case 20: mk('account.closed', { account_id: 'a1', closed_on: '2026-12-31' }); break;
      default: {
        const t = refs();
        if (t !== undefined && t.type !== 'revert') mk('revert', { target: t.event_id });
        else if (events.length > 2) mk('revert', { target: events[events.length - 1].event_id });
      }
    }
  }
  return events;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// FP-24: общий генератор валидных журналов и рабочих областей
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Базовый seed серий: замок движка (500 журналов) и property-тесты (1000 журналов) берут `case_seed(GEN_SEED, i)`. */
export const GEN_SEED = 2026;

/** Крайние значения сумм (REQ-158, REQ-174): 0, ±1, ±2, ±(2^53−1) и соседние с границей. Только для тестов малых журналов и фаззинга. */
export const EDGE_VALUES = Object.freeze([0, 1, -1, 2, -2, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, -(Number.MAX_SAFE_INTEGER - 1)]);

/** Классы малых журналов (`gen_small`): пустой, одно событие, дубли дат и записей, крайние значения сумм. */
export const SMALL_KINDS = Object.freeze(['empty', 'one_event', 'same_date', 'duplicates', 'extreme']);

/**
 * Seed `i`-го журнала серии `base`. Биекция по `i` при фиксированном `base` (xor с номером, умножение на нечётное, сдвиги-xor): все seed одной серии различны,
 * соседние номера дают несвязанные потоки mulberry32. Часов и `Math.random` нет.
 * @param {number} base
 * @param {number} i номер журнала в серии (0…)
 * @returns {number} беззнаковое 32-битное
 */
export function case_seed(base, i) {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (i + 1), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Перемешивание Фишера — Йетса на ГПСЧ (копия, исходный массив не меняется). */
export function shuffled(xs, rng) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = rng.int(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Рабочая область журнала: `reduce(effective_events(events))` — словари «id → запись», как их читает `analyze`. */
export function ws_of(events) {
  return reduce(effective_events(events));
}

/**
 * Построитель журнала: идентификаторы `e00001…`, `seq` подряд, время ввода — на дату `as_of`, чем дальше запись, тем позже.
 * `from` (необязательно, FP-24 · исправление D2) — готовые записи, которые построитель продолжает: `seq` идёт дальше наибольшего; по умолчанию журнал пуст, поток `gen_case` прежний.
 */
function make_builder(as_of_iso, from = []) {
  const events = [...from];
  let seq = from.reduce((m, e) => Math.max(m, e.seq), 0);
  const stamp = (n) => `${as_of_iso}T09:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`;
  const add = (type, payload, extra = {}) => {
    seq += 1;
    const e = make_event(type, payload, { event_id: 'e' + String(seq).padStart(5, '0'), seq, recorded_at: stamp(seq), ...extra });
    events.push(e);
    return e;
  };
  return { events, add };
}

/** Другая версия той же записи для цепочки правок: сумма или имя изменены, знак суммы сохранён. */
function older_version(p, rng) {
  const q = { ...p };
  if (Number.isSafeInteger(q.amount_minor) && q.amount_minor !== 0) q.amount_minor += q.amount_minor > 0 ? rng.int(1, 999) : -rng.int(1, 999);
  else if (typeof q.name === 'string') q.name += ' (старая версия)';
  return q;
}

/**
 * Запись с шумом журнала: обычная; «старая версия, заменённая новой» (`supersedes_id`); «запись, откатанная и возвращённая откатом отката»; «перезапись
 * той же сущности без `supersedes_id`» (последняя по `seq` побеждает, порядок записей важен; версии налоговых правил так не пишутся).
 * Итоговая запись действует во всех четырёх случаях — журнал сворачивается в то же состояние, что и без шума.
 */
function emit(b, rng, noise, type, payload, extra = {}) {
  if (!noise) return b.add(type, payload, extra);
  const r = rng.next();
  if (r < 0.08) {
    const old = b.add(type, older_version(payload, rng), extra);
    return b.add(type, payload, { ...extra, supersedes_id: old.event_id });
  }
  if (r < 0.13) {
    const e = b.add(type, payload, extra);
    const r1 = b.add('revert', { target: e.event_id });
    b.add('revert', { target: r1.event_id });
    return e;
  }
  if (r < 0.2 && type !== 'taxrule.set') {
    b.add(type, older_version(payload, rng), extra);
    return b.add(type, payload, extra);
  }
  return b.add(type, payload, extra);
}

/**
 * Случайный валидный журнал и его рабочая область.
 * Содержимое (по образцу G-001): счета (`acc_main` EUR; иногда `acc_usd` с курсом), календарь, якоря (свежие: возраст ≤ 6 дней), факты, правила (месяц/неделя),
 * поток часов, разовые планы, налоговые правила и резервы (`tax`, `sinking`), параметры. Шум журнала: замены, откаты, откаты откатов и откатанные записи-пустышки.
 * В «готовых» журналах (`ready`, по умолчанию 85 %) есть всё для готовности 4: обязательство, оценка повседневных трат, поступление в ближайшие 45 дней.
 * @param {number} seed
 * @param {{rich?: boolean, usd?: boolean, ready?: boolean, noise?: boolean, stream?: boolean, tax?: boolean, sinking?: boolean, buffer?: boolean}} [o]
 *   любое поле, не заданное явно, выбирается из seed
 * @returns {{seed: number, events: object[], as_of: string, as_of_day: number, horizon_days: number, query: {as_of: string}, ws: object,
 *   flags: {rich: boolean, usd: boolean, ready: boolean, tax: boolean, sinking: boolean, stream: boolean, buffer: boolean}}}
 */
export function gen_case(seed, o = {}) {
  const rng = make_rng(seed);
  const as_of_day = parse_date('2026-01-01') + rng.int(0, 700);
  const as_of = format_date(as_of_day);
  const tiny = rng.next() < 0.08; // вырожденные горизонты (N = 1…4)
  const horizon_days = tiny ? rng.int(1, 3) : rng.int(14, 70); // параметр horizon_days допустим в диапазоне 1…3660 (К-4)
  const rich = o.rich ?? rng.next() < 0.6;
  const usd = o.usd ?? rng.next() < 0.12;
  const ready = o.ready ?? rng.next() < 0.85;
  const noise = o.noise ?? true;
  const stream = o.stream ?? rng.next() < 0.25;
  const tax = o.tax ?? rng.next() < 0.6;
  const tax2 = tax && rng.next() < 0.3;
  const sinking = o.sinking ?? rng.next() < 0.5;
  const buffer = o.buffer ?? rng.next() < 0.95;
  const cal = rng.next() < 0.7;
  const b = make_builder(as_of);
  const put = (type, payload, extra) => emit(b, rng, noise, type, payload, extra);
  const iso = (d) => format_date(d);

  // счета, календарь, курс
  b.add('account.opened', { account_id: 'acc_main', name: 'Основной', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2025-01-01' });
  if (usd) {
    b.add('account.opened', { account_id: 'acc_usd', name: 'Доллары', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, liquidity_bp: 0, opened_on: '2025-01-01' });
    put('fx.set', { fx_id: 'fx1', date: iso(as_of_day - rng.int(0, 20)), base: 'USD', quote: 'EUR', num: rng.int(8000, 11000), den: 10000 });
  }
  if (cal) {
    const holidays = [];
    for (let k = 0; k < rng.int(0, 3); k++) holidays.push(iso(as_of_day + rng.int(1, 40)));
    b.add('calendar.set', { calendar_id: 'cal-main', name: 'сб, вс', weekend_dows: [0, 6], holidays: [...new Set(holidays)].sort() });
  }
  const calendar_id = cal ? 'cal-main' : null;

  // параметры
  const params = {
    horizon_days, 'worse.income_delay_days': rng.pick([0, 3, 7, 14, 14, 21]), 'wave.gap_days': rng.pick([2, 3, 4]), 'wave.max_span_days': rng.pick([7, 10, 14]),
    'wave.threshold_minor': rng.pick([1000, 3000, 20000]), rounding: rng.pick(['half_even', 'half_even', 'half_up']),
  };
  if (buffer) params.buffer_minor = rng.pick([0, 10000, 50000, 50000, 120000, 300000]);
  b.add('params.set', params, { entity_id: 'ws-' + seed });

  // якоря и факты
  const opening = rich ? rng.int(400000, 1500000) : rng.int(-20000, 900000);
  const anchor_age = rng.pick([0, 0, 0, 1, 2, 5, 6]);
  if (rng.next() < 0.3) put('anchor.set', { anchor_id: 'anc_old', account_id: 'acc_main', date: iso(as_of_day - rng.int(20, 60)), amount_minor: opening + rng.int(-50000, 50000) });
  put('anchor.set', { anchor_id: 'anc_main', account_id: 'acc_main', date: iso(as_of_day - anchor_age), amount_minor: opening });
  if (usd) put('anchor.set', { anchor_id: 'anc_usd', account_id: 'acc_usd', date: iso(as_of_day - anchor_age), amount_minor: rng.int(0, 400000) });
  const n_facts = rng.int(0, 8);
  for (let i = 0; i < n_facts; i++) {
    const in_usd = usd && rng.next() < 0.2;
    put('tx.posted', {
      account_id: in_usd ? 'acc_usd' : 'acc_main', date: iso(as_of_day - rng.int(0, 40)), amount_minor: rng.next() < 0.3 ? rng.int(100, 90000) : -rng.int(100, 40000),
      currency: in_usd ? 'USD' : 'EUR', tag: rng.pick(['еда', 'кофе', 'такси', 'work', 'аренда']),
    }, { entity_id: 'tx' + i });
  }

  // правила повторения
  const rule = (rule_id, over) => ({
    rule_id, version: 1, account_id: 'acc_main', name: rule_id, kind: 'expense', currency: 'EUR', interval: 1, month_end: 'clamp', weekend: rng.pick(['keep', 'next', 'prev']),
    calendar_id, exdates: [], is_obligation: false, is_estimate: false, tag: 'прочее', ...over,
  });
  const monthly = (rule_id, amt, over = {}) => rule(rule_id, { freq: 'M', by_monthday: [rng.int(1, 28)], start_date: iso(as_of_day - rng.int(30, 300)), amount: { exp_minor: amt }, kind: amt < 0 ? 'expense' : 'income', ...over });
  const weekly = (rule_id, amt, over = {}) => rule(rule_id, { freq: 'W', by_weekday: [rng.int(0, 6)], start_date: iso(as_of_day - rng.int(30, 300)), amount: { exp_minor: amt }, kind: amt < 0 ? 'expense' : 'income', weekend: 'keep', ...over });
  if (ready) {
    put('rule.set', monthly('R-RENT', -rng.int(20000, 90000), { is_obligation: true, tag: 'аренда' }));
    put('rule.set', weekly('R-GROC', -rng.int(2000, 12000), { is_estimate: true, tag: 'продукты' }));
  }
  for (let i = 0; i < rng.int(0, 3); i++) {
    const income = rng.next() < 0.25;
    const r = rng.next() < 0.5 ? monthly('R' + i, income ? rng.int(5000, 200000) : -rng.int(500, 60000), { is_obligation: !income && rng.next() < 0.6, tag: income ? 'work' : rng.pick(['связь', 'жкх', 'подписка']) })
      : weekly('R' + i, income ? rng.int(5000, 80000) : -rng.int(500, 20000), { is_estimate: !income && rng.next() < 0.3, tag: income ? 'work' : 'еда' });
    put('rule.set', r);
  }

  // поток часов (как S-HOURLY из G-001)
  if (stream) {
    const exp = rng.int(2400, 9000);
    put('stream.set', {
      stream_id: 'S1', account_id: 'acc_main', name: 'Почасовая работа', currency: 'EUR', rate_minor: rng.int(1500, 6000), period: 'month', cutoff: { kind: 'month_end' },
      pay_lag_days: rng.int(3, 10), weekend: 'next', calendar_id, hours: { min_minutes: Math.floor(exp * 0.8), exp_minutes: exp, max_minutes: Math.floor(exp * 1.2) },
      hours_by_period: {}, pace_minutes_per_day: 180, bonus: [],
    });
  }

  // резервы и налоговые правила
  const reserve_ids = [];
  const mk_tax = (n, rate_bp, funded) => {
    const reserve_id = 'RES-T' + n;
    reserve_ids.push(reserve_id);
    put('taxrule.set', {
      tax_rule_id: 'TR-' + n, version: 1, name: 'Налог ' + n, kind: 'percent_of_income', rate_bp, base: 'gross', applies_to: { stream_ids: stream ? ['S1'] : [], tags: ['work'] },
      valid_from: '2025-01-01', valid_to: null, rounding: 'half_even', reserve_id, recorded_at: '2025-01-02T10:00:00Z',
    });
    put('reserve.set', { reserve_id, kind: 'tax', name: 'Налог ' + n, currency: 'EUR', funded_start_minor: funded, funded_as_of: as_of, tax_rule_id: 'TR-' + n, backed_by_account_id: null });
  };
  if (tax) mk_tax(1, rng.int(0, 5000), rng.int(0, 200000));
  if (tax2) mk_tax(2, rng.int(0, 4000), rng.int(0, 80000));
  if (sinking) {
    const funded = rng.int(0, 30000);
    reserve_ids.push('RES-S');
    put('reserve.set', {
      reserve_id: 'RES-S', kind: 'sinking', name: 'Накопление', currency: 'EUR', funded_start_minor: funded, funded_as_of: as_of, target_minor: funded + rng.int(0, 120000),
      due_date: iso(as_of_day + rng.int(10, 200)), cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', backed_by_account_id: null,
    });
  }

  // разовые планы
  if (ready) {
    put('plan.set', { plan_id: 'P-INC', account_id: 'acc_main', name: 'P-INC', date: iso(as_of_day + rng.int(3, 30)), amount_minor: rng.int(20000, rich ? 250000 : 400000), currency: 'EUR', kind: 'income', tag: 'work', is_obligation: false, is_estimate: false });
  }
  const n_plans = rng.int(0, 18);
  for (let i = 0; i < n_plans; i++) {
    const income = rng.next() < 0.35;
    const in_usd = usd && rng.next() < 0.15;
    const amt = income ? rng.int(1, rich ? 250000 : 400000) : -rng.int(1, rich ? 60000 : 250000);
    put('plan.set', {
      plan_id: 'P' + i, account_id: in_usd ? 'acc_usd' : 'acc_main', name: 'P' + i, date: iso(as_of_day + rng.int(-2, horizon_days + 5)), amount_minor: amt, currency: in_usd ? 'USD' : 'EUR',
      kind: income ? 'income' : 'expense', tag: income ? (rng.next() < 0.8 ? 'work' : 'gift') : rng.pick(['еда', 'аренда', 'прочее']),
      is_obligation: !income && rng.next() < 0.5, is_estimate: !income && rng.next() < 0.2,
      ...(!income && !in_usd && reserve_ids.length > 0 && rng.next() < 0.3 ? { reserve_id: rng.pick(reserve_ids) } : {}),
    });
  }
  // запись-пустышка: добавлена и откатана, в итоговом состоянии её нет
  if (noise && rng.next() < 0.3) {
    const e = b.add('plan.set', { plan_id: 'PX' + rng.int(1, 999), account_id: 'acc_main', date: iso(as_of_day + 1), amount_minor: -rng.int(1, 5000), currency: 'EUR', kind: 'expense', tag: 'откат' });
    b.add('revert', { target: e.event_id });
  }
  const events = b.events;
  return {
    seed, events, as_of, as_of_day, horizon_days, query: { as_of }, ws: ws_of(events),
    flags: { rich, usd, ready, tax, sinking, stream, buffer },
  };
}

// ── «зеркальные» факты для сопоставления план ↔ факт (FP-24 · исправление D2) ────────────────────────────────────────────────

/** Доля журналов серии свойств, в которые добавляются зеркальные факты (замок движка их не использует: он берёт `gen_case` как есть). */
export const MIRROR_SHARE = 0.6;

/**
 * Случайные факты `gen_case` не повторяют плановые вхождения, поэтому сопоставление «план ↔ факт» (ALG-13) в расчёте находило пару лишь в 6 журналах из 1000, и часть TST-32
 * («повторное сопоставление») проходила вхолостую. Здесь журнал серии свойств получает ДОПОЛНИТЕЛЬНЫЕ записи, не меняя поток `gen_case` (сумма журнала в `engine.lock.json` та же):
 *  1. факты-зеркала: для части плановых вхождений окна `[начало окна плана, as_of]` — факт `tx.posted` на тот же счёт и в той же валюте, обычно на ту же сумму, иногда в пределах допуска
 *     `match.tol_bp` и с лагом в день-два (не позже `as_of`);
 *  2. если вхождений в окне нет (или жребий): разовый план `P-MIRR` на дату окна и факт к нему.
 * Возвращает НОВЫЙ случай (исходный не меняется): `events` дополнены, `ws` пересчитана, `mirrored` — число зеркальных фактов, `planted` — число добавленных разовых планов.
 * Жребий и значения берутся из собственного потока `make_rng(seed ^ 'mirr')`, поэтому результат повторяем и не зависит от остальных тестов.
 * @param {ReturnType<typeof gen_case>} c
 * @param {number} [share] доля журналов, получающих зеркала
 */
export function with_mirror_facts(c, share = MIRROR_SHARE) {
  const rng = make_rng((c.seed ^ 0x6d697272) >>> 0);
  if (!(rng.next() < share)) return { ...c, mirrored: 0, planted: 0 };
  const asof = c.as_of_day;
  const f0 = plan_window_start(c.ws, c.as_of);
  const occ = plan_occurrences(c.ws, f0, asof, { as_of: asof, anchor_cut: true })
    .filter((e) => e.date >= f0 && e.date <= asof && Number.isSafeInteger(e.amount_minor) && e.amount_minor !== 0);
  const b = make_builder(c.as_of, c.events);
  let mirrored = 0;
  let planted = 0;
  /** Факт-зеркало вхождения `e`: сумма та же либо отличается не более чем на 3 % (допуск сопоставления — 5 %), дата сдвинута на 0…2 дня, но не позже `as_of`. */
  const mirror = (e) => {
    const exact = rng.next() < 0.75;
    const amount = exact ? e.amount_minor : e.amount_minor + Math.trunc((e.amount_minor * rng.int(-300, 300)) / 10000);
    const lag = rng.pick([0, 0, 0, 0, 1, 1, 2]);
    const date = Math.min(asof, e.date + lag);
    b.add('tx.posted', {
      account_id: e.account_id, date: format_date(date), amount_minor: amount === 0 ? e.amount_minor : amount, currency: e.currency ?? 'EUR', tag: e.tag === undefined || e.tag === '' ? 'прочее' : e.tag,
    }, { entity_id: 'mir' + mirrored });
    mirrored += 1;
  };
  for (const e of occ) if (mirrored < 6 && rng.next() < 0.7) mirror(e);
  if (mirrored === 0 && rng.next() < 0.8) {
    const date = rng.int(f0, asof);
    const amount = rng.next() < 0.3 ? rng.int(2000, 90000) : -rng.int(500, 40000);
    const plan = {
      plan_id: 'P-MIRR', account_id: 'acc_main', name: 'P-MIRR', date: format_date(date), amount_minor: amount, currency: 'EUR', kind: amount > 0 ? 'income' : 'expense',
      tag: amount > 0 ? 'work' : 'прочее', is_obligation: false, is_estimate: false,
    };
    b.add('plan.set', plan);
    planted += 1;
    mirror({ account_id: 'acc_main', date, amount_minor: amount, currency: 'EUR', tag: plan.tag });
  }
  if (mirrored === 0 && planted === 0) return { ...c, mirrored: 0, planted: 0 };
  return { ...c, events: b.events, ws: ws_of(b.events), mirrored, planted };
}

// ── малые журналы ────────────────────────────────────────────────────────────────────────────────────────────────

/** Базовые записи малого журнала: счёт и якорь на `as_of`. */
function small_base(b, as_of_iso, amount = 100000) {
  b.add('account.opened', { account_id: 'acc_main', name: 'Основной', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  b.add('anchor.set', { anchor_id: 'anc_main', account_id: 'acc_main', date: as_of_iso, amount_minor: amount });
}

/**
 * Малый журнал одного из классов `SMALL_KINDS` (REQ-158: «пустой журнал», «одно событие», «дубли дат», значения ±(2^53−1)). Журнал может быть невалидным
 * (так задумано): тесты проверяют, что движок отвечает результатом или кодом из набора REQ-017, а не исключением.
 * @param {number} seed
 * @param {'empty'|'one_event'|'same_date'|'duplicates'|'extreme'} kind
 * @returns {{seed: number, kind: string, events: object[], as_of: string, query: {as_of: string}, ws: object|null, reduce_error: string|null}}
 */
export function gen_small(seed, kind) {
  const rng = make_rng(seed);
  const as_of = format_date(parse_date('2026-03-01') + rng.int(0, 400));
  const d = (k) => format_date(parse_date(as_of) + k);
  const b = make_builder(as_of);
  const plan = (id, date, amt, extra = {}) => ({ plan_id: id, account_id: 'acc_main', name: id, date, amount_minor: amt, currency: 'EUR', kind: amt >= 0 ? 'income' : 'expense', tag: 'x', ...extra });
  if (kind === 'empty') {
    // ни одной записи
  } else if (kind === 'one_event') {
    const one = rng.int(0, 9);
    switch (one) {
      case 0: b.add('account.opened', { account_id: 'acc_main', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }); break;
      case 1: b.add('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: as_of, amount_minor: rng.int(-1000, 100000) }); break;
      case 2: b.add('plan.set', plan('P1', d(rng.int(0, 20)), rng.pick([-5000, 5000, 1]))); break;
      case 3: b.add('tx.posted', { account_id: 'acc_main', date: as_of, amount_minor: -rng.int(1, 5000), currency: 'EUR' }, { entity_id: 'tx1' }); break;
      case 4: b.add('params.set', { buffer_minor: rng.int(0, 90000), horizon_days: rng.int(0, 90) }, { entity_id: 'ws1' }); break;
      case 5: b.add('rule.set', { rule_id: 'R1', account_id: 'acc_main', kind: 'expense', amount: { exp_minor: -100 }, currency: 'EUR', freq: 'M', interval: 1, start_date: d(-30), by_monthday: [5] }); break;
      case 6: b.add('taxrule.set', { tax_rule_id: 'TR1', version: 1, kind: 'percent_of_income', rate_bp: rng.int(0, 5000), base: 'gross', applies_to: { stream_ids: [], tags: [] }, valid_from: '2025-01-01', valid_to: null, rounding: 'half_even', reserve_id: 'RES1', recorded_at: '2025-01-02T10:00:00Z' }); break;
      case 7: b.add('calendar.set', { calendar_id: 'c1', name: 'c', weekend_dows: [0, 6], holidays: [] }); break;
      case 8: b.add('fx.set', { fx_id: 'f1', date: as_of, base: 'USD', quote: 'EUR', num: rng.int(1, 99), den: 100 }); break;
      default: b.add('scenario.set', { scenario_id: 's1', name: 'S', ops: [] }); break;
    }
  } else if (kind === 'same_date') {
    small_base(b, as_of);
    const day = d(rng.int(0, 5));
    const n = rng.int(2, 14);
    for (let i = 0; i < n; i++) b.add('plan.set', plan('P' + i, day, rng.pick([-2500, -2500, 4000, -100, 100, 100000])));
    for (let i = 0; i < rng.int(0, 4); i++) b.add('tx.posted', { account_id: 'acc_main', date: as_of, amount_minor: rng.pick([-500, 500, -500]), currency: 'EUR' }, { entity_id: 'tx' + i });
    b.add('params.set', { horizon_days: rng.int(0, 12), buffer_minor: rng.pick([0, 1000]) }, { entity_id: 'ws1' });
  } else if (kind === 'duplicates') {
    small_base(b, as_of);
    const amt = -rng.int(1, 9000);
    const n = rng.int(2, 8);
    for (let i = 0; i < n; i++) b.add('plan.set', plan('P' + i, d(3), amt)); // одинаковые даты и суммы под разными id
    b.add('plan.set', plan('P0', d(3), amt)); // та же сущность повторно: перезапись
    b.add('anchor.set', { anchor_id: 'anc_main', account_id: 'acc_main', date: as_of, amount_minor: 100000 }); // якорь повторно
    for (let i = 0; i < rng.int(0, 3); i++) b.add('tx.posted', { account_id: 'acc_main', date: as_of, amount_minor: -700, currency: 'EUR' }, { entity_id: 'tx' + (i % 2) });
    if (rng.next() < 0.3) b.events.push({ ...b.events[b.events.length - 1] }); // дубль записи целиком: тот же event_id и seq (журнал невалиден)
  } else if (kind === 'extreme') {
    const pick = () => rng.pick(EDGE_VALUES);
    b.add('account.opened', { account_id: 'acc_main', name: 'Основной', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
    b.add('anchor.set', { anchor_id: 'anc_main', account_id: 'acc_main', date: as_of, amount_minor: pick() });
    for (let i = 0; i < rng.int(0, 5); i++) {
      const v = pick();
      b.add('plan.set', plan('P' + i, d(rng.int(0, 9)), v === 0 ? 1 : v));
    }
    for (let i = 0; i < rng.int(0, 3); i++) b.add('tx.posted', { account_id: 'acc_main', date: as_of, amount_minor: pick(), currency: 'EUR' }, { entity_id: 'tx' + i });
    b.add('params.set', { buffer_minor: Math.abs(pick()), horizon_days: rng.int(0, 10) }, { entity_id: 'ws1' });
  } else throw new Error('неизвестный класс малого журнала: ' + kind);
  let ws = null;
  let reduce_error = null;
  try { ws = ws_of(b.events); } catch (e) { reduce_error = String(e?.code ?? e?.name ?? 'Error'); }
  return { seed, kind, events: b.events, as_of, query: { as_of }, ws, reduce_error };
}

