// debt_ext.mjs — долг, записанный в прогноз: сохранённый график, перенос строки, досрочное погашение и ре-якорение по факту (FP-14, REQ-082, REQ-083,
// ALG-09 A09.3–A09.5, IDEA-22). Надстройка над debt.mjs: график считает ядро (`amortization_schedule`, `prepay`, `reanchor`), здесь он превращается в
// запись `DebtPlan` со сохранённым `schedule` и в её правки. Все функции чистые: «сегодня» (`as_of`) приходит аргументом, правка возвращает НОВУЮ запись.
//
// Запись долга (`ws.debts[]`, поверх канона C-039; поля сверх канона необязательны):
//   debt_id, name, pay_account_id, [account_id], currency, kind, rate_bp, rounding — условия;
//   principal_minor — долг до первой строки графика на момент добавления (после правок не пересчитывается: график — источник истины);
//   n = число строк графика, start_date = дата первой строки (обе подгоняются под `schedule` после каждой правки);
//   schedule[{k, date, payment_minor, interest_minor, principal_minor, balance_minor, extra_minor?}] — строки, даты ISO. Выполненные платежи остаются в графике:
//   ре-якорение и досрочное погашение считаются «после платежа k». `extra_minor` — записанное досрочное погашение в день строки k: деньги уходят со счёта сверх
//   платежа (`schedule_to_events` даёт для него отдельное плановое обязательство `<debt_id>@<дата>#extra`), а `balance_minor` строки уже уменьшен на эту сумму;
//   history[{kind: 'move'|'prepay'|'reanchor', …, on}] — что и когда применил пользователь (числа и даты, без пользовательских текстов), последние HISTORY_MAX
//   (запись о переносе строки, которой после «срока короче» или закрытия сверкой в графике уже нет, из списка уходит; даты хвоста при пересчёте остаются прежними).
//
// Допуск дрейфа сверки — `debt.drift_tol_bp` (`DEBT_DEFAULTS`: общая таблица умолчаний для долгов; зеркало vocab.json, значение — гипотеза v2).
// График по модели не равен договору банка (дни, комиссии, плавающая ставка): это расчёт по введённым данным, не консультация.
// Зависимости: money, dates, debt. Модуль не реэкспортируется из index.mjs; ни часов, ни случайности, ни ввода-вывода.

import { fail, assert_minor, sum_minor } from './money.mjs';
import { to_epoch_day, format_date, add_months } from './dates.mjs';
import { amortization_schedule, prepay, reanchor, schedule_to_events, validate_debt } from './debt.mjs';
import { vdefault as vd } from './param_defaults.mjs';

/** Умолчания параметров долга: читаются из `vocab.json → params` через `vocab.generated.mjs` (FP-17, REQ-019); тест сверяет с файлом. */
export const DEBT_DEFAULTS = Object.freeze({ 'debt.drift_tol_bp': vd('debt.drift_tol_bp') });

/** Сколько записей «что применено» хранит долг (старые вытесняются; полная история — в журнале). */
export const HISTORY_MAX = 200;

/** Допуск дрейфа (bp) из параметров рабочей области: целое ≥ 0, иначе умолчание. */
export function drift_tol_bp(params) {
  const v = params === null || typeof params !== 'object' ? undefined : params['debt.drift_tol_bp'];
  return Number.isSafeInteger(v) && v >= 0 ? v : DEBT_DEFAULTS['debt.drift_tol_bp'];
}

/** Режим округления графика из параметров рабочей области: график знает только `half_even` и `half_up` (N9), остальное — `half_even`. */
export function rounding_of(params) {
  return params !== null && typeof params === 'object' && params.rounding === 'half_up' ? 'half_up' : 'half_even';
}

/**
 * Строки графика долга как они сохранены (даты — EpochDay): сохранённый `schedule` либо расчёт по полям записи (долг из файла без графика).
 * @param {object} debt
 * @returns {object[]}
 */
export function rows_of(debt) {
  if (Array.isArray(debt.schedule)) return debt.schedule.map((r, i) => ({ ...r, k: i + 1, date: to_epoch_day(r.date) })); // номер строки — её место в графике (в чужом файле `k` бывает любым)
  return amortization_schedule({
    principal: debt.principal_minor, rate_bp: debt.rate_bp, n: debt.n, start: debt.start_date, cadence: debt.cadence, kind: debt.kind, rounding: debt.rounding ?? 'half_even',
  });
}

/**
 * Строки для хранения: нумерация с 1, даты ISO, только известные поля (`extra_minor` — когда он больше нуля).
 * @param {object[]} rows строки с датами EpochDay или ISO
 * @returns {object[]}
 */
export function stored_rows(rows) {
  return rows.map((r, i) => {
    const o = {
      k: i + 1, date: format_date(to_epoch_day(r.date)), payment_minor: assert_minor(r.payment_minor), interest_minor: assert_minor(r.interest_minor),
      principal_minor: assert_minor(r.principal_minor), balance_minor: assert_minor(r.balance_minor),
    };
    const extra = r.extra_minor === undefined || r.extra_minor === null ? 0 : assert_minor(r.extra_minor);
    if (extra > 0) o.extra_minor = extra;
    return o;
  });
}

/**
 * Запись долга со сохранённым графиком (REQ-082): ограничения графика (C-041) проверяет `validate_debt`; аннуитет под 0 % — `installment_0`.
 * Платёжный счёт, валюту и курс проверяет вызывающий (правка `upsert_debt`): функция не видит счетов.
 * @param {{debt_id: string, name?: string, pay_account_id: string, account_id?: string, currency: string, kind: 'annuity'|'differential'|'installment_0',
 *   principal_minor: number, rate_bp: number, n: number, start_date: string|number, rounding?: 'half_even'|'half_up'}} spec
 * @returns {object} запись для `ws.debts`
 * @throws {RunwayError} E_SCHEMA (ограничения графика), E_NOT_INTEGER, E_BAD_DATE
 */
export function build_debt_record(spec) {
  const kind = spec.kind === 'annuity' && spec.rate_bp === 0 ? 'installment_0' : spec.kind;
  const rounding = spec.rounding ?? 'half_even';
  validate_debt(spec.principal_minor, spec.rate_bp, spec.n, kind);
  const rows = amortization_schedule({ principal: spec.principal_minor, rate_bp: spec.rate_bp, n: spec.n, start: spec.start_date, kind, rounding });
  const rec = { debt_id: spec.debt_id };
  if (spec.name !== undefined) rec.name = spec.name;
  rec.pay_account_id = spec.pay_account_id;
  if (spec.account_id !== undefined) rec.account_id = spec.account_id;
  Object.assign(rec, {
    currency: spec.currency, kind, principal_minor: spec.principal_minor, rate_bp: spec.rate_bp, n: rows.length, start_date: format_date(rows[0].date), rounding,
    schedule: stored_rows(rows),
  });
  return rec;
}

/** Есть запись о сверке с банком на платеже позже `k` (её остаток потерялся бы при пересчёте хвоста с `k`). */
function reanchored_after(debt, k) {
  return Array.isArray(debt.history) && debt.history.some((e) => e?.kind === 'reanchor' && Number.isSafeInteger(e.k) && e.k > k);
}

/**
 * Хвост графика после пересчёта ядром — с прежними датами. Ядро (`prepay`, `reanchor`) строит даты хвоста заново, помесячно от даты первой строки хвоста,
 * а дата платежа договорная: перенос, записанный пользователем (`move_row_date`), пересчёт стирать не должен (REQ-082). Строки с номером позиции ≥ `from`,
 * которые были в прежнем графике, получают прежнюю дату по месту; строки сверх прежней длины (срок «короче» может дать хвост на строку длиннее)
 * продолжают помесячно от последней прежней даты. Прежний порядок дат строгий, продолжение идёт позже последней даты — порядок сохраняется.
 * @param {object[]} old_rows строки до пересчёта (даты EpochDay)
 * @param {object[]} new_rows строки после пересчёта (даты EpochDay)
 * @param {number} from позиция (с 0) первой строки, пересчитанной ядром
 * @returns {object[]}
 */
function keep_dates(old_rows, new_rows, from) {
  const last = old_rows.length - 1;
  return new_rows.map((r, i) => (i < from ? r : { ...r, date: i <= last ? old_rows[i].date : add_months(old_rows[last].date, i - last) }));
}

/**
 * Запись долга с новым графиком и одной записью в «что применено»; `n` и `start_date` следуют за графиком. Записи о переносе строки, которой в графике
 * уже нет (досрочное погашение «срок короче» или закрытие сверкой убрали хвост), из «что применено» уходят: список показывает то, что действует сейчас
 * (полная история — в журнале рабочей области).
 */
function with_schedule(debt, rows, entry) {
  const schedule = stored_rows(rows);
  const kept = (Array.isArray(debt.history) ? debt.history : []).filter((e) => !(e?.kind === 'move' && Number.isSafeInteger(e.k) && e.k > schedule.length));
  const history = [...kept, entry].slice(-HISTORY_MAX);
  return { ...debt, n: schedule.length, start_date: schedule[0].date, schedule, history };
}

/**
 * REQ-082: перенос даты одной строки сохранённого графика (по образцу `move_part_date` рассрочки): сумма не меняется, сдвиг выходных не применяется.
 * Дата новая должна быть не раньше `as_of`, строго позже предыдущей строки и строго раньше следующей (график остаётся по порядку).
 * @param {object} debt
 * @param {number} k номер строки с 1
 * @param {string} new_date ISO
 * @param {string} as_of ISO «сегодня»
 * @returns {object} новая запись долга
 * @throws {RunwayError} E_SCHEMA (нет строки, порядок, дата не изменилась), E_BAD_DATE
 */
export function move_row_date(debt, k, new_date, as_of) {
  const rows = rows_of(debt);
  const kk = assert_minor(k);
  if (kk < 1 || kk > rows.length) fail('E_SCHEMA', { reason: 'row_out_of_range', k: kk, n: rows.length });
  const d = to_epoch_day(new_date);
  const today = to_epoch_day(as_of);
  if (d < today) fail('E_BAD_DATE', { reason: 'row_date_before_as_of' });
  if (kk > 1 && d <= rows[kk - 2].date) fail('E_SCHEMA', { reason: 'row_date_not_after_previous', k: kk });
  if (kk < rows.length && d >= rows[kk].date) fail('E_SCHEMA', { reason: 'row_date_not_before_next', k: kk });
  const from = rows[kk - 1].date;
  if (d === from) fail('E_SCHEMA', { reason: 'row_date_unchanged', k: kk });
  rows[kk - 1] = { ...rows[kk - 1], date: d };
  return with_schedule(debt, rows, { kind: 'move', k: kk, from: format_date(from), to: format_date(d), on: format_date(today) });
}

/**
 * REQ-083: досрочное погашение, записанное в сохранённый долг. Дата — дата строки графика (не последней, C-040); `shorten` — платёж прежний, срок короче;
 * `lower_payment` — срок прежний, платёж ниже. Платёж «прежний» — платёж первой строки после строки погашения (не первой строки всего графика и не оплаченной
 * строки погашения): после ре-якорения или прежнего досрочного погашения в тот же день это действующий платёж. Строка погашения получает `extra_minor`,
 * её остаток уменьшается на внесённую сумму; суммы хвоста считает `prepay` ядра, даты хвоста остаются прежними (перенос платежа не теряется).
 * Правки применяются по порядку: хвост после строки погашения пересчитывается заново, поэтому позже уже записанное досрочное погашение или сверка с банком
 * потерялись бы — вместо молчаливой потери отказ (`later_prepay_exists`, `later_reanchor_exists`).
 * @param {object} debt
 * @param {{date: string, amount_minor: number, option: 'shorten'|'lower_payment', as_of: string}} p
 * @returns {object} новая запись долга
 * @throws {RunwayError} E_SCHEMA (дата не совпала с платежом, последний платёж, сумма вне 1…остаток, платёж не покрывает проценты, позже записана правка)
 */
export function apply_prepay(debt, { date, amount_minor, option, as_of }) {
  const rows = rows_of(debt);
  const d = to_epoch_day(date);
  const idx = rows.findIndex((r) => r.date === d);
  if (idx < 0 || idx === rows.length - 1) fail('E_SCHEMA', { reason: 'prepay_only_on_payment_date_before_last', date: format_date(d) });
  if (option !== 'shorten' && option !== 'lower_payment') fail('E_SCHEMA', { reason: 'unknown_prepay_option', value: String(option) });
  const amt = assert_minor(amount_minor);
  const at = rows[idx];
  if (amt <= 0 || amt > at.balance_minor) fail('E_SCHEMA', { reason: 'prepay_amount_out_of_range', amount: amt, balance: at.balance_minor });
  if (rows.slice(idx + 1).some((r) => (r.extra_minor ?? 0) > 0)) fail('E_SCHEMA', { reason: 'later_prepay_exists', k: idx + 1 });
  if (reanchored_after(debt, idx + 1)) fail('E_SCHEMA', { reason: 'later_reanchor_exists', k: idx + 1 });
  // хвост считает ядро на графике, который начинается со строки погашения. «Прежний платёж» (`shorten`) — платёж, который действует ПОСЛЕ строки погашения,
  // то есть платёж первой пересчитываемой строки: платёж самой строки погашения уже внесён и после сверки вверх или «платёжа ниже» в тот же день устарел
  // (иначе «срок короче» брал бы старый, меньший платёж и удлинял график). На свежем графике оба платежа равны.
  const first_tail = rows[idx + 1];
  const res = prepay({ ...debt, schedule: [{ ...at, payment_minor: first_tail.payment_minor }, ...rows.slice(idx + 1)] }, amt, d, option);
  const done = { ...at, balance_minor: at.balance_minor - amt, extra_minor: (at.extra_minor ?? 0) + amt };
  // даты хвоста — прежние (перенесённые пользователем платежи пересчёт не стирает), считает ядро только суммы
  const next = keep_dates(rows, [...rows.slice(0, idx), done, ...res.slice(1)], idx + 1);
  return with_schedule(debt, next, { kind: 'prepay', k: idx + 1, date: format_date(d), amount_minor: amt, option, on: format_date(to_epoch_day(as_of)) });
}

/**
 * REQ-083: ре-якорение по факту, записанное в сохранённый долг: после `k` платежей банк показал остаток `observed_minor`; наблюдаемый остаток заменяет
 * модельный в строке `k`, суммы хвоста пересчитаны от него (срок и даты хвоста не меняются, перенесённые платежи остаются на своих датах). Отказ вместо молчаливой потери: остаток > 0 после последнего платежа (график не
 * продлевается), запланированное досрочное погашение в заменяемом хвосте и более поздняя сверка с банком (её остаток тоже потерялся бы).
 * @param {object} debt
 * @param {{k: number, observed_minor: number, as_of: string}} p
 * @returns {{debt: object, drift_minor: number, modeled_minor: number}}
 * @throws {RunwayError} E_SCHEMA (k вне 1…n, остаток < 0, остаток после последнего платежа, досрочное или сверка позже, хвост не строится)
 */
export function apply_reanchor(debt, { k, observed_minor, as_of }) {
  const rows = rows_of(debt);
  const kk = assert_minor(k);
  const obs = assert_minor(observed_minor);
  if (kk < 1 || kk > rows.length) fail('E_SCHEMA', { reason: 'k_out_of_1_n', k: kk, n: rows.length });
  if (obs < 0) fail('E_SCHEMA', { reason: 'observed_negative', value: obs });
  if (obs > 0 && kk === rows.length) fail('E_SCHEMA', { reason: 'balance_after_last_payment', k: kk });
  if (rows.slice(kk).some((r) => (r.extra_minor ?? 0) > 0)) fail('E_SCHEMA', { reason: 'planned_prepay_after_k', k: kk });
  if (reanchored_after(debt, kk)) fail('E_SCHEMA', { reason: 'later_reanchor_exists', k: kk });
  const modeled = rows[kk - 1].balance_minor;
  const res = reanchor({ ...debt, schedule: rows }, kk, obs);
  // сумма хвоста — от наблюдаемого остатка (ядро), даты хвоста — прежние: перенесённые пользователем платежи сверка не сдвигает
  const next = keep_dates(rows, res.schedule.map((r, i) => (i === kk - 1 ? { ...r, balance_minor: obs } : r)), kk);
  const changed = with_schedule(debt, next, { kind: 'reanchor', k: kk, date: format_date(rows[kk - 1].date), observed_minor: obs, drift_minor: res.drift, on: format_date(to_epoch_day(as_of)) });
  return { debt: changed, drift_minor: res.drift, modeled_minor: modeled };
}

/**
 * Итоги по строкам: число платежей, сумма платежей, проценты, записанные досрочные (`extra_minor`), первый и последний платёж, дата последнего.
 * @param {object[]} rows строки с датой EpochDay или ISO
 * @returns {{count: number, total_minor: number, interest_minor: number, extra_minor: number, first_payment_minor: number, last_payment_minor: number, last_date: string}|null} `null` для пустого списка
 */
export function rows_totals(rows) {
  if (rows.length === 0) return null;
  return {
    count: rows.length,
    total_minor: sum_minor(rows.map((r) => r.payment_minor)),
    interest_minor: sum_minor(rows.map((r) => r.interest_minor)),
    extra_minor: sum_minor(rows.map((r) => r.extra_minor ?? 0)),
    first_payment_minor: rows[0].payment_minor,
    last_payment_minor: rows[rows.length - 1].payment_minor,
    last_date: format_date(to_epoch_day(rows[rows.length - 1].date)),
  };
}

/**
 * Платежи (с досрочными) за горизонтом прогноза — те же события, что `build_events` не включает в ряд и о которых говорит `W_DEBT_BEYOND_HORIZON`.
 * @param {object} debt
 * @param {string|number} horizon_end
 * @returns {{count: number, total_minor: number, first_date: string|null}}
 */
export function beyond_horizon_payments(debt, horizon_end) {
  const hz = to_epoch_day(horizon_end);
  const evs = schedule_to_events(debt).filter((e) => e.date > hz);
  return { count: evs.length, total_minor: -sum_minor(evs.map((e) => e.amount_minor)), first_date: evs.length === 0 ? null : format_date(evs[0].date) };
}

/**
 * Состояние долга на дату: остаток по модели, платежи впереди, ближайший платёж, платежи за горизонтом.
 * «Прошедшие» строки — с датой раньше `as_of` (оплачены ли они, знает пользователь: подтверждает факт или сверяет остаток).
 * @param {object} debt
 * @param {string|number} as_of
 * @param {string|number} horizon_end
 * @returns {{rows: object[], count: number, past_count: number, outstanding_minor: number, next: object|null, upcoming: object|null,
 *   beyond: {count: number, total_minor: number, first_date: string|null}}} `upcoming` — итоги строк с датой не раньше `as_of` (`rows_totals`)
 */
export function debt_status(debt, as_of, horizon_end) {
  const rows = rows_of(debt);
  const today = to_epoch_day(as_of);
  const past = rows.filter((r) => r.date < today);
  const ahead = rows.filter((r) => r.date >= today);
  const outstanding = past.length === 0 ? rows[0].balance_minor + rows[0].principal_minor + (rows[0].extra_minor ?? 0) : past[past.length - 1].balance_minor;
  return {
    rows,
    count: rows.length,
    past_count: past.length,
    outstanding_minor: outstanding,
    next: ahead.length === 0 ? null : ahead[0],
    upcoming: rows_totals(ahead),
    beyond: beyond_horizon_payments(debt, horizon_end),
  };
}
