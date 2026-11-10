// import_model.mjs — чистая модель мастера импорта (FP-06; REQ-091, REQ-092, REQ-093, REQ-099; ALG-14, ADR-011).
// Здесь нет DOM, часов и сети: всё, что мастер решает «по данным», считается здесь и проверяется в Node (tests/import_wizard.test.mjs).
// Экран (import_wizard.mjs) только рисует результат этих функций и вызывает `ctx.set_ws`.
//
// Что умеет модель:
//   - размер файла ≤ 5 МБ проверяется ДО разбора (`check_size`, `decode_bytes`); профиль — это данные: без regex, без исполняемых полей,
//     без ключей `__proto__`/`constructor`/`prototype` (`read_profile_text`, `build_profile`, движок `validate_profile`);
//   - CSV: разделитель, образец строк, догадка о колонках (`sniff_csv`, `suggest_mapping`), профиль из сопоставления колонок (`build_profile`),
//     сухой прогон (`plan_csv`) — «распознано · отклонено · дубликатов · возможных двойников», сумма трёх равна числу строк файла;
//   - hledger: подмножество через `import_hledger` с тем же сухим прогоном (`plan_hledger`); `@`/`@@` и больше двух активных ног — явный отказ
//     `E_SCHEMA` и строки «не поддержано» (`scan_hledger`), а не молчаливая потеря;
//   - запись партии (`commit_plan`) и откат партии (`rollback_batch`) — чистые преобразования рабочей области; рабочая область не мутируется;
//   - `ws_state_hash(ws)` — хэш состояния, свёрнутого из рабочей области: до «Подтвердить» он не меняется, после отката возвращается.
// FP-18 (REQ-091, REQ-095):
//   - собственный CSV Runway (`export_csv`, `runway-csv/1`) читается встроенным профилем `runway-csv-1`: суммы в минимальных единицах, строки плана
//     пропускаются, ведущий «'» снимается; файл узнаётся по заголовку (`recommend_profile`). Для своих колонок единицы суммы — `amount_unit`
//     (`major` | `minor`), по названию колонки («amount_minor», «cents») подставляется `minor` (`looks_minor`);
//   - сухой прогон предупреждает (`report.warnings`): название колонки суммы указывает на минимальные единицы, а она читается как основные
//     (`minor_as_major`), или самая крупная сумма файла намного больше остатка и крупнейшей операции на счёте (`amount_scale`);
//   - разбор большого файла может идти в Web Worker (`plan_csv_async`, клиент — import_worker_client.mjs) с откатом на главный поток; результаты те же;
//   - остальные стадии большого файла не держат страницу одной длинной задачей: образец колонок берётся с головы файла, строки считает `count_csv_rows`
//     (`sniff_csv`), а после разбора сверка с данными, хэш файла (SubtleCrypto вне главного потока) и отчёт идут отдельными задачами (`plan_csv_async`).
// Недоверенный текст (описания операций, названия счетов из файла) наружу уходит только как значение полей; в разметку его кладёт экран
// через textContent. Расчёт по введённым данным и правилам, не консультация.

import {
  parse_csv, detect_delimiter, parse_date_fmt, parse_with_profile, validate_profile, dry_run, import_commit, import_hledger, MAX_IMPORT_BYTES,
} from '../engine/io.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { dedup_key, norm, state_hash, sha256, to_epoch_day, format_date, currency_exponent } from '../engine/index.mjs';
import { ws_to_state, assert_safe_json } from './ws_bridge.mjs';
import { ID_KINDS } from './ws_edit.mjs';
import { is_valid_id } from './ids.mjs';
// FP-29 (волна 3а-2): часы из CSV и строки в чужой валюте с двумя ногами; веток в этом файле немного, вся логика — в import_v11.mjs и engine/hours_io.mjs, engine/io_fx_rows.mjs
import { exchange_legs } from '../engine/io_fx_rows.mjs';
import {
  is_hours_profile, has_fx_block, is_v11_profile_id, recommend_v11_profile, v11_profile, read_v11_profile_obj, new_v11_state, v11_patch, V11_KEYS, v11_run_extra,
  apply_fx_rows, plan_hours, commit_hours, rollback_hours, is_hours_batch, hours_importable,
} from './import_v11.mjs';

export { MAX_IMPORT_BYTES };

/** Предел размера файла профиля (JSON), байт: профиль — маленькие данные. */
export const MAX_PROFILE_BYTES = 64 * 1024;

/** Шаги мастера CSV по порядку. У вкладки hledger шага «колонки» нет. */
export const STEPS = Object.freeze(['file', 'columns', 'report', 'done']);

/** Кодировки, которые умеет читать мастер (метки `TextDecoder`). */
export const ENCODINGS = Object.freeze(['utf-8', 'windows-1251', 'windows-1252', 'iso-8859-1']);

/** Форматы даты для сопоставления колонок (шаблон движка `parse_date_fmt`). */
export const DATE_FORMATS = Object.freeze(['YYYY-MM-DD', 'DD/MM/YYYY', 'DD.MM.YYYY', 'DD-MM-YYYY', 'MM/DD/YYYY', 'D.M.YYYY', 'D/M/YYYY', 'YYYY/MM/DD', 'YYYY.MM.DD']);

/** Причины отклонения строки (движок + мастер). Для каждой есть строка `import.rj_<причина>` в каталоге. */
export const REJECT_REASONS = Object.freeze([
  'short_row', 'filtered_out', 'bad_date', 'future_date', 'unknown_currency', 'currency_mismatch', 'bad_amount', 'empty_amount', 'both_debit_credit',
  'sign_in_debit_credit', 'zero_amount', 'account_conflict', 'transfer_half',
]);

/** Причины отказа (поле `ctx.reason` ошибки). Для каждой есть строка `import.err_<причина>` в каталоге. */
export const ERROR_REASONS = Object.freeze([
  'file_too_large', 'bad_profile', 'unterminated_quote', 'no_header_row', 'unknown_column', 'column_index_out_of_header', 'bad_delimiter',
  'bad_json', 'profile_too_large', 'profile_not_text', 'forbidden_key', 'unsupported_encoding', 'decode_failed', 'unknown_account', 'no_workspace',
  'stale_plan', 'nothing_to_import', 'unknown_batch', 'validation_failed', 'bad_mapping', 'bad_rules', 'duplicate_id', 'unsupported_constructs',
  'text_not_string', 'other',
]);

/** Причины «не поддержано» у hledger. Для каждой есть строка `import.hl_why_<причина>` в каталоге. */
export const HL_REASONS = Object.freeze([
  'price_unit', 'price_total', 'more_than_two_assets', 'more_than_one_posting_without_amount', 'cannot_infer_amount', 'bad_date', 'bad_amount',
  'amount_without_commodity', 'bad_price', 'periodic_needs_one_asset', 'unsupported_period', 'periodic_without_from', 'other',
]);

const HL_ENGINE_REASON = Object.freeze({
  hledger_unit_price_not_supported: 'price_unit',
  more_than_two_asset_postings_not_supported: 'more_than_two_assets',
  more_than_one_posting_without_amount: 'more_than_one_posting_without_amount',
  cannot_infer_amount: 'cannot_infer_amount',
  bad_hledger_date: 'bad_date',
  bad_hledger_amount: 'bad_amount',
  hledger_amount_without_commodity: 'amount_without_commodity',
  bad_price: 'bad_price',
  periodic_needs_one_asset_posting: 'periodic_needs_one_asset',
  unsupported_period_expression: 'unsupported_period',
  periodic_without_from: 'periodic_without_from',
});

// ── вспомогательное ───────────────────────────────────────────────────────────────────────────────────────────────

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);
const clone = (x) => JSON.parse(JSON.stringify(x));
const clip = (s, n) => String(s).slice(0, n);

function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

/** Отказ мастера: код канона и контекст `{reason, …}`; текстов из файла в контексте нет. */
export function refuse(reason, extra, code = 'E_SCHEMA') {
  return { ok: false, error: { code, ctx: { reason, ...extra } } };
}

/** Исключение движка → `{code, ctx}` без значений из файла (поле `value` и списки ошибок схемы режутся). */
export function err_of(e) {
  const code = typeof e?.code === 'string' ? e.code : 'E_SCHEMA';
  const c = is_obj(e?.ctx) ? e.ctx : {};
  const ctx = { reason: typeof c.reason === 'string' ? c.reason : 'other' };
  for (const k of ['line', 'row', 'limit', 'col', 'where']) if (typeof c[k] === 'number' || (k !== 'line' && typeof c[k] === 'string' && c[k].length <= 40)) ctx[k] = c[k];
  if (Array.isArray(c.errors)) ctx.errors = c.errors.slice(0, 10).map((x) => ({ field: clip(x?.field ?? '', 40), reason: clip(x?.reason ?? '', 40) }));
  return { code, ctx };
}

const as_error = (e) => ({ ok: false, error: err_of(e) });

/** Строка причины для каталога: известная причина как есть, иначе `other`. */
export function reason_id(error) {
  const r = error?.ctx?.reason;
  return ERROR_REASONS.includes(r) ? r : 'other';
}

/** Идентификатор сущности другого вида уже занимает `id` (единое пространство Id, C-025). */
function id_taken_elsewhere(ws, id, own_kind) {
  for (const [kind, [bucket, field]] of Object.entries(ID_KINDS)) {
    if (kind === own_kind) continue;
    const arr = bucket === 'tax_rules' ? list(ws, bucket).flat() : list(ws, bucket);
    if (arr.some((x) => x?.[field] === id)) return true;
  }
  return false;
}

// ── встроенные профили (копии data/profiles/*.json: сверяются тестом) ────────────────────────────────────────────

/** Встроенные профили: данные, как в `data/profiles/<id>.json`. Тест сверяет их с файлами, чтобы копия не разошлась. */
export const BUILTIN_PROFILES = deep_freeze({
  'csv-generic': {
    profile_id: 'csv-generic', v: 1, encoding: 'utf-8', delimiter: ',', skip: 0,
    date: { col: 'Date', fmt: 'YYYY-MM-DD' },
    amount: { mode: 'signed', col: 'Amount', decimal: '.', thousands: ',' },
    currency: { col: 'Currency' },
    desc: { cols: ['Description'] },
    rules: [],
  },
  'csv-semicolon-dmy': {
    profile_id: 'csv-semicolon-dmy', v: 1, encoding: 'utf-8', delimiter: ';', skip: 0,
    date: { col: 'Date', fmt: 'DD/MM/YYYY' },
    amount: { mode: 'signed', col: 'Amount', decimal: ',', thousands: '.' },
    currency: { col: 'Currency' },
    desc: { cols: ['Description'] },
    rules: [],
  },
  // Собственный CSV журнала Runway (`export_csv`, C-045): сумма — целые минимальные единицы (`amount_minor`), в описании снимается ведущий «'»,
  // строки плана (`layer` ≠ `posted`) пропускаются. Метка (`tag`) и контрагент (`counterparty`) возвращаются из своих колонок, если они есть в файле (REQ-095, FP-47);
  // `account_id` и `kind` файла не читаются (решение владельца). Совпадает с `RUNWAY_CSV_PROFILE` движка и с `data/profiles/runway-csv-1.json` (тест сверки).
  'runway-csv-1': {
    profile_id: 'runway-csv/1', v: 1, encoding: 'utf-8', delimiter: ',', skip: 0,
    date: { col: 'date', fmt: 'YYYY-MM-DD' },
    amount: { mode: 'signed', col: 'amount_minor', unit: 'minor' },
    currency: { col: 'currency' },
    desc: { cols: ['note'], csv_safe: true },
    rules: [],
    filter: { col: 'layer', equals: 'posted' },
    tag: { col: 'tag', csv_safe: true, optional: true },
    counterparty: { col: 'counterparty', csv_safe: true, optional: true },
  },
});

/**
 * Профили, которые узнаются по заголовку независимо от разделителя: набор колонок собственного формата Runway ни с чем не спутать, а файл,
 * пересохранённый в таблице, часто получает `;` вместо `,`. Для них разбор берёт разделитель, найденный в файле (`wiz_csv_profile`).
 */
const DELIMITER_FREE = Object.freeze(new Set(['runway-csv-1']));

/** С какого размера файла (байт) разбор уходит в Web Worker (если он доступен): запуск воркера и копирование текста для малых файлов дороже самого разбора. */
export const WORKER_MIN_BYTES = 128 * 1024;

/**
 * Во сколько раз самая крупная сумма файла должна превысить остаток и крупнейшую величину на счёте, чтобы сухой прогон предупредил
 * (`amount_scale`). Неверно прочитанные минимальные единицы завышают суммы в 10^k раз (k — знаков после запятой у валюты).
 */
export const SCALE_RATIO = 20;

/**
 * Название колонки суммы указывает на минимальные единицы: «amount_minor», «AmountMinor», «Minor units», «Amount (cents)».
 * Это подсказка для первого приближения и предупреждения, а не доказательство: решает профиль или выбор пользователя.
 * @param {unknown} name
 * @returns {boolean}
 */
export function looks_minor(name) {
  return typeof name === 'string' && /minor(?!ity)|(?:^|[^a-z])cents?(?:[^a-z]|$)/i.test(name);
}

// ── размер, кодировка, профиль из файла ─────────────────────────────────────────────────────────────────────────────

/**
 * Размер файла до чтения: больше 5 МБ — отказ `E_SCHEMA` (`file_too_large`) ещё до разбора (REQ-091).
 * @param {number} size байт
 * @param {number} [limit]
 * @returns {{ok: true} | {ok: false, error: object}}
 */
export function check_size(size, limit = MAX_IMPORT_BYTES) {
  if (!Number.isFinite(size) || size < 0) return refuse('file_too_large', { limit });
  return size > limit ? refuse('file_too_large', { limit }) : { ok: true };
}

/**
 * Байты файла → текст. Размер проверяется до декодирования; кодировка — из списка `ENCODINGS`.
 * @param {Uint8Array} bytes
 * @param {string} [encoding]
 * @returns {{ok: true, text: string} | {ok: false, error: object}}
 */
export function decode_bytes(bytes, encoding = 'utf-8') {
  const s = check_size(bytes?.length ?? Infinity);
  if (!s.ok) return s;
  if (!ENCODINGS.includes(encoding)) return refuse('unsupported_encoding');
  try {
    return { ok: true, text: new TextDecoder(encoding, { fatal: false }).decode(bytes) };
  } catch { return refuse('decode_failed'); }
}

/**
 * Профиль из файла пользователя (JSON): недоверенные данные. Отвергается: большой файл, не-JSON, ключи `__proto__`/`constructor`/`prototype`
 * на любой глубине, любое поле вне схемы `ImportProfile` (в том числе `regex`, `script`, `transform` — исполняемых полей нет), неизвестная кодировка.
 * @param {string} text
 * @returns {{ok: true, profile: object} | {ok: false, error: object}}
 */
export function read_profile_text(text) {
  if (typeof text !== 'string') return refuse('profile_not_text');
  if (text.length > MAX_PROFILE_BYTES || new TextEncoder().encode(text).length > MAX_PROFILE_BYTES) return refuse('profile_too_large', { limit: MAX_PROFILE_BYTES });
  let obj;
  try { obj = JSON.parse(text); } catch { return refuse('bad_json'); }
  try { assert_safe_json(obj, 'profile'); } catch { return refuse('forbidden_key'); }
  const v11 = read_v11_profile_obj(obj); // FP-29: профиль «часы» и профиль строк обмена (блок fx) проверяются своими правилами, `null` — обычный профиль
  if (v11 !== null) return v11.ok && obj.encoding !== undefined && !ENCODINGS.includes(obj.encoding) ? refuse('unsupported_encoding') : v11;
  const v = validate_profile(obj);
  if (!v.ok) return refuse('bad_profile', { errors: v.errors.slice(0, 10).map((x) => ({ field: clip(x.field, 40), reason: clip(x.reason, 40) })) });
  if (obj.encoding !== undefined && !ENCODINGS.includes(obj.encoding)) return refuse('unsupported_encoding');
  return { ok: true, profile: clone(obj) };
}

// ── CSV: образец и догадки ──────────────────────────────────────────────────────────────────────────────────────────

/** Сколько строк с данными берёт образец колонок (`samples`); угадывание формата чисел и дат смотрит только на них. */
const SAMPLE_ROWS = 60;

/** Сколько знаков головы файла разбирается первой, когда файл большой (`sniff_csv`); если записей в голове мало, голова растёт вчетверо. */
export const SNIFF_HEAD_CHARS = 64 * 1024;

/**
 * Число записей CSV, которые оставит `parse_csv` (пустые записи отбрасываются), без построения строк и массивов: тот же автомат состояний, но только
 * счётчики. Поле в кавычках пропускается через `indexOf`, поэтому разбор файла в 5 МБ занимает порядка 20 мс вместо полусекунды. Совпадение с
 * `parse_csv(text, {delimiter}).length` проверяется тестом на случайных входах.
 * @param {string} text
 * @param {string} delimiter один знак: `,`, `;` или TAB
 * @returns {number} число записей; `-1` — кавычка не закрыта (там `parse_csv` бросил бы `unterminated_quote`)
 */
export function count_csv_rows(text, delimiter) {
  const d = delimiter.charCodeAt(0);
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // BOM, как в parse_csv
  let field_len = 0; // длина текущего поля (важно только «пусто / не пусто»: кавычка открывает поле лишь в его начале)
  let row_len = 0; // сколько полей в записи уже закрыто разделителями
  let row_any = false; // в записи есть непустое поле
  let kept = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34 && field_len === 0) {
      i += 1;
      for (;;) { // поле в кавычках: ищем закрывающую кавычку, «""» внутри — литерал
        const q = text.indexOf('"', i);
        if (q < 0) return -1;
        field_len += q - i;
        if (text.charCodeAt(q + 1) === 34) { field_len += 1; i = q + 2; } else { i = q + 1; break; }
      }
    } else if (c === d) {
      row_len += 1;
      if (field_len > 0) row_any = true;
      field_len = 0;
      i += 1;
    } else if (c === 10 || c === 13) {
      i += 1;
      if (c === 13 && text.charCodeAt(i) === 10) i += 1;
      if (field_len > 0) row_any = true;
      if (row_any) kept += 1;
      row_len = 0; row_any = false; field_len = 0;
    } else { field_len += 1; i += 1; }
  }
  if (field_len > 0 || row_len > 0) { // последняя запись без перевода строки
    if (field_len > 0) row_any = true;
    if (row_any) kept += 1;
  }
  return kept;
}

/** Образец по тексту целиком или по его голове: `out` — как у `sniff_csv`, `rows_len` — сколько записей разобрано (для проверки, что головы хватило). */
function sniff_rows(text, opts) {
  const skip = Number.isInteger(opts.skip) && opts.skip >= 0 ? opts.skip : 0;
  // разделитель определяется по заголовку (после преамбулы), а не по первой строке файла
  const probe = skip > 0 ? text.split(/\r\n|\n|\r/).slice(skip).join('\n') : text;
  const want = opts.delimiter === undefined || opts.delimiter === 'auto' ? detect_delimiter(probe) : opts.delimiter;
  if (![',', ';', '\t'].includes(want)) return { out: refuse('bad_delimiter'), rows_len: 0 };
  let rows;
  try { rows = parse_csv(text, { delimiter: want }); } catch (e) { return { out: as_error(e), rows_len: 0 }; }
  if (rows.length <= skip) return { out: refuse('no_header_row'), rows_len: rows.length };
  const header = rows[skip].map((c) => c.trim());
  const body = rows.slice(skip + 1);
  return { out: { ok: true, delimiter: want, header, preview: body.slice(0, 6), samples: body.slice(0, SAMPLE_ROWS), rows_total: body.length }, rows_len: rows.length };
}

/**
 * Образец файла: разделитель (по первой записи или заданный), заголовок (после `skip` строк преамбулы), первые строки.
 * Файл от `WORKER_MIN_BYTES` не разбирается целиком ради шести строк: заголовок и образец берутся с головы (она растёт, пока в ней нет записей
 * для образца и ещё одной сверх того), а число строк считает `count_csv_rows`. Результат тот же, что при разборе целиком, включая отказ
 * `unterminated_quote` на оборванной кавычке в любом месте файла (проверяется тестом); на файле в 5 МБ это порядка 30 мс вместо полусекунды.
 * @param {string} text
 * @param {{delimiter?: string, skip?: number, prefix_min?: number, head_chars?: number}} [opts] `delimiter`: `'auto'`, `,`, `;` или TAB;
 *   `prefix_min` и `head_chars` — пороги (для тестов)
 * @returns {{ok: true, delimiter: string, header: string[], preview: string[][], samples: string[][], rows_total: number} | {ok: false, error: object}}
 */
export function sniff_csv(text, opts = {}) {
  if (typeof text !== 'string') return refuse('text_not_string');
  if (text.length < (opts.prefix_min ?? WORKER_MIN_BYTES)) return sniff_rows(text, opts).out;
  const skip = Number.isInteger(opts.skip) && opts.skip >= 0 ? opts.skip : 0;
  let cut = Math.max(1, opts.head_chars ?? SNIFF_HEAD_CHARS);
  for (;;) {
    // голова кончается на границе строки: посреди поля в кавычках (в банковских выписках это большая часть текста) разбор отказал бы и голову пришлось бы растить
    const nl = text.indexOf('\n', cut);
    const cr = text.indexOf('\r', cut);
    const end = (nl < 0 ? cr : (cr < 0 ? nl : Math.min(nl, cr))) + 1;
    if (end === 0 || end >= text.length) break; // строки после головы нет: разбираем целиком
    const head = sniff_rows(text.slice(0, end), opts);
    if (!head.out.ok && head.out.error.ctx.reason === 'bad_delimiter') return head.out; // от головы не зависит
    // голова годится, если в ней заголовок, записи образца и ещё одна: последняя запись головы могла оборваться на её границе
    if (head.out.ok && head.rows_len >= skip + 1 + SAMPLE_ROWS + 1) {
      const n = count_csv_rows(text, head.out.delimiter);
      if (n < 0) return refuse('unterminated_quote'); // как у parse_csv на всём файле
      return { ...head.out, rows_total: n - skip - 1 };
    }
    cut *= 4; // кавычка оборвана границей головы, записей мало или заголовок длиннее головы: берём больше
  }
  return sniff_rows(text, opts).out;
}

const HEADER_NAMES = Object.freeze({
  date: ['date', 'datum', 'fecha', 'data', 'дата', 'booking date', 'posting date', 'transaction date', 'buchungstag', 'value date', 'дата операции'],
  amount: ['amount', 'betrag', 'importe', 'сумма', 'sum', 'value', 'сумма операции', 'summe'],
  debit: ['debit', 'soll', 'cargo', 'дебет', 'расход', 'withdrawal', 'withdrawals', 'paid out', 'money out'],
  credit: ['credit', 'haben', 'abono', 'кредит', 'приход', 'deposit', 'deposits', 'paid in', 'money in'],
  desc: ['description', 'details', 'memo', 'payee', 'narrative', 'verwendungszweck', 'concepto', 'описание', 'назначение', 'назначение платежа', 'comment', 'note', 'reference', 'text', 'beschreibung'],
  currency: ['currency', 'curr', 'ccy', 'währung', 'moneda', 'валюта', 'cur'],
});

function find_col(header, kind, taken = []) {
  const low = header.map((h) => h.toLowerCase());
  const names = HEADER_NAMES[kind];
  let i = low.findIndex((h, k) => !taken.includes(k) && names.includes(h));
  if (i < 0) i = low.findIndex((h, k) => !taken.includes(k) && h !== '' && names.some((n) => h.includes(n)));
  return i;
}

/** Формат даты по образцам ячеек: первый из `DATE_FORMATS`, которому подчиняются все непустые ячейки (иначе ISO). */
export function guess_date_format(cells) {
  const vals = cells.map((c) => String(c).trim()).filter((c) => c !== '');
  if (vals.length === 0) return 'YYYY-MM-DD';
  return DATE_FORMATS.find((f) => vals.every((v) => parse_date_fmt(v, f) !== null)) ?? 'YYYY-MM-DD';
}

/** Десятичный знак и разделитель тысяч по образцам ячеек суммы. */
export function guess_number_format(cells) {
  const vals = cells.map((c) => String(c).trim().replace(/−/g, '-')).filter((c) => c !== '');
  let comma = 0;
  let dot = 0;
  for (const v of vals) { if (/,\d{1,2}$/.test(v)) comma += 1; else if (/\.\d{1,2}$/.test(v)) dot += 1; }
  const decimal = comma > dot ? ',' : '.';
  const other = decimal === ',' ? '.' : ',';
  const thousands = vals.some((v) => v.includes(other) && new RegExp('\\d\\' + other + '\\d{3}(?!\\d)').test(v)) ? other : (vals.some((v) => /\d \d{3}(?!\d)/.test(v)) ? ' ' : '');
  return { decimal, thousands };
}

/**
 * Первое приближение сопоставления колонок по заголовку и образцам. Колонка `-1` — не найдена (форма покажет, что выбрать).
 * @param {{delimiter: string, header: string[], samples: string[][]}} sniff результат `sniff_csv`
 * @param {{skip?: number, encoding?: string}} [o]
 */
export function suggest_mapping(sniff, o = {}) {
  const h = sniff.header;
  const date = find_col(h, 'date');
  const debit = find_col(h, 'debit');
  const credit = find_col(h, 'credit');
  const amount = find_col(h, 'amount', [date]);
  const currency = find_col(h, 'currency', [date, amount]);
  const desc = find_col(h, 'desc', [date, amount, debit, credit, currency]);
  const col_samples = (i) => (i < 0 ? [] : sniff.samples.map((r) => r[i] ?? ''));
  const mode = amount < 0 && debit >= 0 && credit >= 0 ? 'debit_credit' : 'signed';
  const num_cells = mode === 'signed' ? col_samples(amount) : [...col_samples(debit), ...col_samples(credit)];
  const nf = guess_number_format(num_cells);
  // единицы суммы: колонка с названием «…_minor» / «cents» — целые минимальные единицы (4730 = 47,30), иначе основные (12,50)
  const unit = mode === 'signed' && amount >= 0 && looks_minor(h[amount]) ? 'minor' : 'major';
  return {
    delimiter: sniff.delimiter, skip: o.skip ?? 0, encoding: o.encoding ?? 'utf-8',
    date_col: date, date_fmt: guess_date_format(col_samples(date)),
    amount_mode: mode, amount_unit: unit, amount_col: amount, debit_col: debit, credit_col: credit, decimal: nf.decimal, thousands: nf.thousands,
    currency_mode: currency >= 0 ? 'column' : 'account', currency_col: currency,
    desc_cols: desc >= 0 ? [desc] : [], rules_text: '',
  };
}

/**
 * Встроенный профиль, который подходит файлу (тот же разделитель — кроме профилей из `DELIMITER_FREE`, все названные колонки, в том числе колонка
 * фильтра, есть в заголовке), иначе `null`. Собственный CSV Runway узнаётся по заголовку: date, amount_minor, currency, note, layer.
 */
export function recommend_profile(sniff) {
  for (const [id, p] of Object.entries(BUILTIN_PROFILES)) {
    if ((p.delimiter !== sniff.delimiter && !DELIMITER_FREE.has(id)) || (p.skip ?? 0) !== 0) continue;
    const need = [p.date.col, p.amount.col, p.currency.col, ...p.desc.cols, ...(p.filter === undefined ? [] : [p.filter.col])];
    if (need.every((n) => sniff.header.includes(n))) return id;
  }
  return null;
}

/**
 * Правила меток из текста: строка «подстрока = метка» (ведущий `^` у подстроки — «начинается с»); пустые строки пропускаются.
 * Литералы, без regex (REQ-091). До 50 правил, подстрока и метка — до 100 знаков.
 * @param {string} text
 * @returns {{ok: true, rules: {match: string, tag: string}[]} | {ok: false, error: object}}
 */
export function parse_rules_text(text) {
  const rules = [];
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    const match = eq < 0 ? '' : line.slice(0, eq).trim();
    const tag = eq < 0 ? '' : line.slice(eq + 1).trim();
    if (match === '' || tag === '' || match.length > 100 || tag.length > 100 || norm(match.startsWith('^') ? match.slice(1) : match) === '' || /[\u0000-\u001f\u007f]/.test(match + tag)) {
      return refuse('bad_rules', { line: i + 1 });
    }
    rules.push({ match, tag });
    if (rules.length > 50) return refuse('bad_rules', { line: i + 1 });
  }
  return { ok: true, rules };
}

/**
 * Профиль CSV из сопоставления колонок. Колонка в профиле — по имени из заголовка, если оно непустое и единственное, иначе по номеру.
 * Валидация — движком (`validate_profile`): неизвестных полей и исполняемых значений здесь не создаётся.
 * @param {object} mapping результат `suggest_mapping` (с правками пользователя)
 * @param {{header: string[]}} sniff
 * @param {{currency: string}} account счёт, на который идёт импорт (валюта — когда `currency_mode = 'account'`)
 * @returns {{ok: true, profile: object} | {ok: false, error: object}}
 */
export function build_profile(mapping, sniff, account) {
  if (!is_obj(mapping) || !is_obj(sniff) || !Array.isArray(sniff.header)) return refuse('bad_mapping', { field: 'mapping' });
  const header = sniff.header;
  const ok_col = (i) => Number.isInteger(i) && i >= 0 && i < header.length;
  const ref = (i) => (header[i] !== '' && header.indexOf(header[i]) === header.lastIndexOf(header[i]) ? header[i] : i);
  const bad = (field) => refuse('bad_mapping', { field });
  if (!ok_col(mapping.date_col)) return bad('date_col');
  if (!DATE_FORMATS.includes(mapping.date_fmt)) return bad('date_fmt');
  if (!Array.isArray(mapping.desc_cols) || mapping.desc_cols.length === 0 || !mapping.desc_cols.every(ok_col)) return bad('desc_cols');
  if (![',', '.'].includes(mapping.decimal)) return bad('decimal');
  if (!['', ' ', ',', '.'].includes(mapping.thousands) || mapping.thousands === mapping.decimal) return bad('thousands');
  const skip = Number.isInteger(mapping.skip) && mapping.skip >= 0 ? mapping.skip : 0;
  // единицы суммы: основные (по умолчанию, профиль без поля `unit`, как раньше) или минимальные (`unit: 'minor'`, только для одной колонки со знаком)
  const unit = mapping.amount_unit ?? 'major';
  if (unit !== 'major' && unit !== 'minor') return bad('amount_unit');
  const amount = { mode: mapping.amount_mode, decimal: mapping.decimal };
  if (mapping.thousands !== '') amount.thousands = mapping.thousands;
  if (mapping.amount_mode === 'signed') {
    if (!ok_col(mapping.amount_col)) return bad('amount_col');
    amount.col = ref(mapping.amount_col);
    if (unit === 'minor') amount.unit = 'minor';
  } else if (mapping.amount_mode === 'debit_credit') {
    if (unit === 'minor') return bad('amount_unit');
    if (!ok_col(mapping.debit_col) || !ok_col(mapping.credit_col) || mapping.debit_col === mapping.credit_col) return bad('debit_credit');
    amount.debit = ref(mapping.debit_col);
    amount.credit = ref(mapping.credit_col);
  } else return bad('amount_mode');
  let currency;
  if (mapping.currency_mode === 'account') {
    if (typeof account?.currency !== 'string') return bad('currency_mode');
    currency = { fixed: account.currency };
  } else if (mapping.currency_mode === 'column') {
    if (!ok_col(mapping.currency_col)) return bad('currency_col');
    currency = { col: ref(mapping.currency_col) };
  } else return bad('currency_mode');
  const rules = parse_rules_text(mapping.rules_text);
  if (!rules.ok) return rules;
  const encoding = ENCODINGS.includes(mapping.encoding) ? mapping.encoding : 'utf-8';
  const profile = {
    profile_id: 'custom', v: 1, encoding, delimiter: mapping.delimiter, skip,
    date: { col: ref(mapping.date_col), fmt: mapping.date_fmt },
    amount, currency, desc: { cols: [...new Set(mapping.desc_cols)].map(ref) }, rules: rules.rules,
  };
  const v = validate_profile(profile);
  if (!v.ok) return refuse('bad_profile', { errors: v.errors.slice(0, 10) });
  return { ok: true, profile };
}

// ── сухой прогон ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Ключи дедупликации и факты рабочей области для `dry_run`. */
function existing_of(ws) {
  const facts = list(ws, 'facts').filter(is_obj);
  const keys = new Set();
  for (const f of facts) if (typeof f.dedup_key === 'string') keys.add(f.dedup_key);
  return { facts, keys };
}

/** Последняя дата якоря счёта (ISO) или `null`. */
function last_anchor(ws, account_id) {
  let best = null;
  for (const a of list(ws, 'anchors')) if (a?.account_id === account_id && typeof a.date === 'string' && (best === null || a.date > best)) best = a.date;
  return best;
}

/**
 * Свести результат `dry_run` в отчёт мастера. Инвариант REQ-092: распознано + отклонено + дубликатов = строк файла.
 * @param {ReturnType<typeof dry_run>} dry
 * @param {{row: number, reason: string}[]} rejects
 * @param {object} [ws] рабочая область (для строк, дата которых не позже последнего якоря счёта)
 * @param {object[]} [warnings] предупреждения сухого прогона (`import_warnings`): не отказ, а повод проверить файл до «Подтвердить»
 */
export function make_report(dry, rejects, ws, warnings = []) {
  const by_reason = {};
  for (const r of rejects) by_reason[r.reason] = (by_reason[r.reason] ?? 0) + 1;
  let net = 0;
  let covered = 0;
  const anchors = new Map();
  const iso_of = new Map(); // день → строка ISO: в файле в 5 МБ около 50 тысяч строк на пару тысяч дней, форматировать каждую строку заново — лишние десятки миллисекунд
  const iso = (day) => { let s = iso_of.get(day); if (s === undefined) { s = format_date(day); iso_of.set(day, s); } return s; };
  for (const c of dry.recognized_items) {
    net += c.amount_minor;
    if (ws !== undefined) {
      if (!anchors.has(c.account_id)) anchors.set(c.account_id, last_anchor(ws, c.account_id));
      const a = anchors.get(c.account_id);
      if (a !== null && iso(c.date) <= a) covered += 1;
    }
  }
  return {
    rows_total: dry.rows_total, recognized: dry.recognized, rejected: dry.rejected, duplicates: dry.duplicates, doubles: dry.doubles.length,
    sum_ok: dry.recognized + dry.rejected + dry.duplicates === dry.rows_total,
    by_reason, reject_rows: rejects.slice(0, 200), net_minor: net, covered_by_anchor: covered,
    from: dry.from === null ? null : format_date(dry.from), to: dry.to === null ? null : format_date(dry.to),
    overlap_days: dry.overlap_days, gap_days: dry.gap_days, warnings,
  };
}

// ── предупреждения сухого прогона: «единицы суммы» ───────────────────────────────────────────────────────────────

/** Крупнейшая величина на счёте, минимальные единицы: остаток (последний якорь плюс факты после него), любой якорь, любой факт. 0 — сравнивать не с чем. */
function account_scale_ref(ws, account_id) {
  let ref = 0;
  let anchor_date = null;
  let balance = 0;
  const anchors = list(ws, 'anchors').filter((a) => is_obj(a) && a.account_id === account_id && Number.isSafeInteger(a.amount_minor) && typeof a.date === 'string');
  for (const a of anchors) {
    ref = Math.max(ref, Math.abs(a.amount_minor));
    if (anchor_date === null || a.date >= anchor_date) { anchor_date = a.date; balance = a.amount_minor; }
  }
  for (const f of list(ws, 'facts')) {
    if (!is_obj(f) || f.account_id !== account_id || !Number.isSafeInteger(f.amount_minor)) continue;
    ref = Math.max(ref, Math.abs(f.amount_minor));
    if (anchor_date === null || (typeof f.date === 'string' && f.date > anchor_date)) balance += f.amount_minor;
  }
  return Math.max(ref, Math.abs(balance));
}

/**
 * Предупреждение `amount_scale`: самая крупная сумма среди записываемых строк больше `SCALE_RATIO` остатков и крупнейших величин на счёте.
 * Так выглядит файл в минимальных единицах, прочитанный как основные (в 100 раз для валюты с двумя знаками). Сравнение целочисленное (BigInt).
 * @param {object} ws
 * @param {string} account_id
 * @param {{amount_minor: number}[]} items строки, которые попали бы в запись
 * @returns {{code: 'amount_scale', ratio: number, peak_minor: number, ref_minor: number} | null}
 */
export function scale_warning(ws, account_id, items) {
  if (items.length === 0) return null;
  const ref = account_scale_ref(ws, account_id);
  if (ref <= 0) return null;
  let peak = 0;
  for (const c of items) peak = Math.max(peak, Math.abs(c.amount_minor));
  if (BigInt(peak) <= BigInt(SCALE_RATIO) * BigInt(ref)) return null;
  return { code: 'amount_scale', ratio: Number(BigInt(peak) / BigInt(ref)), peak_minor: peak, ref_minor: ref };
}

/**
 * Предупреждение `minor_as_major`: название колонки суммы указывает на минимальные единицы, а профиль читает её как основные.
 * Для валюты без дробной части разницы нет, предупреждения тоже.
 * @param {object} profile
 * @param {string[]|undefined} header заголовок файла (колонки профиля по номеру разбираются по нему)
 * @param {number|null} exponent знаков после запятой у валюты счёта
 * @returns {{code: 'minor_as_major', col: string, factor: number} | null}
 */
export function minor_warning(profile, header, exponent) {
  const a = profile?.amount;
  if (!is_obj(a) || a.unit === 'minor' || !Number.isInteger(exponent) || exponent <= 0 || exponent > 9) return null;
  const refs = a.mode === 'signed' ? [a.col] : [a.debit, a.credit];
  const names = refs.map((r) => (typeof r === 'string' ? r : (Array.isArray(header) && Number.isInteger(r) ? header[r] : undefined))).filter((n) => typeof n === 'string');
  const hit = names.find(looks_minor);
  return hit === undefined ? null : { code: 'minor_as_major', col: clip(hit.trim(), 40), factor: 10 ** exponent };
}

/** Предупреждения плана CSV: единицы суммы по названию колонки и по масштабу сумм. Порядок: сначала название, затем масштаб. */
function csv_warnings(ws, input, acc, items) {
  const out = [];
  let exponent = null;
  try { exponent = currency_exponent(acc.currency); } catch { exponent = null; }
  const m = minor_warning(input.profile, input.header, exponent);
  if (m !== null) out.push(m);
  const s = scale_warning(ws, acc.account_id, items);
  // профиль уже читает минимальные единицы: текст «возможно прочитана как основные» был бы неверен, экран покажет нейтральную формулировку
  if (s !== null) out.push(input.profile?.amount?.unit === 'minor' ? { ...s, unit: 'minor' } : s);
  return out;
}

function run_dry(ws, candidates, rejects) {
  const { facts, keys } = existing_of(ws);
  return dry_run(candidates, keys, rejects, facts, is_obj(ws.params) ? ws.params : {});
}

function open_account(ws, account_id) {
  const as_of = typeof ws?.as_of === 'string' ? ws.as_of : '';
  const a = list(ws, 'accounts').find((x) => x?.account_id === account_id);
  return a !== undefined && (typeof a.closed_on !== 'string' || a.closed_on > as_of) ? a : null;
}

/** Счета, на которые можно импортировать: не закрытые на `as_of`. */
export function import_accounts(ws) {
  return list(ws, 'accounts').filter((a) => is_obj(a) && typeof a.account_id === 'string' && open_account(ws, a.account_id) !== null);
}

/** Счёт по умолчанию: первый операционный открытый, иначе первый открытый, иначе `null`. */
export function default_import_account(ws) {
  const open = import_accounts(ws);
  return (open.find((a) => a.liquidity === 'operating') ?? open[0])?.account_id ?? null;
}

/** Общая часть синхронного и асинхронного сухого прогона CSV: проверки до разбора (рабочая область, счёт, размер файла). */
function prepare_csv(ws, input) {
  if (!is_obj(ws) || typeof ws.as_of !== 'string') return refuse('no_workspace');
  const acc = open_account(ws, input.account_id);
  if (acc === null) return refuse('unknown_account');
  const bytes = input.bytes ?? input.text;
  const size = typeof bytes === 'string' ? new TextEncoder().encode(bytes).length : bytes.length;
  const sz = check_size(size);
  if (!sz.ok) return sz; // до разбора
  return { ok: true, acc, bytes, size, ctx: { account_id: acc.account_id, account_currency: acc.currency, as_of: ws.as_of } };
}

/** Сверка разобранных строк с рабочей областью и предупреждения единиц суммы: первая часть второй половины сухого прогона CSV. */
function csv_dry(ws, input, pre, parsed) {
  let dry;
  try { dry = run_dry(ws, parsed.candidates, parsed.rejects); } catch (e) { return as_error(e); }
  return { ok: true, dry, warnings: csv_warnings(ws, input, pre.acc, dry.recognized_items) };
}

/** План по сверке `csv_dry` и хэшу файла: отчёт собирается здесь. */
function csv_plan(ws, input, pre, parsed, parse, d, hash) {
  const plan = {
    kind: 'csv', base_ws: ws, account_id: pre.acc.account_id, currency: pre.acc.currency, profile_id: input.profile.profile_id ?? 'custom',
    source: { name: clip(input.name ?? '', 120), size: pre.size, bytes: pre.bytes, hash },
    candidates: parsed.candidates, dry: d.dry, report: make_report(d.dry, parsed.rejects, ws, d.warnings), pairs: new Map(), extras: null, unsupported: [],
    parse,
  };
  return { ok: true, plan };
}

/** Вторая половина сухого прогона CSV: сверка разобранных строк с рабочей областью и план. Не зависит от того, где шёл разбор. */
function finish_csv(ws, input, pre, parsed, parse) {
  const d = csv_dry(ws, input, pre, parsed);
  if (!d.ok) return d;
  return csv_plan(ws, input, pre, parsed, parse, d, sha256(pre.bytes));
}

/** Хэш файла SHA-256 (64 hex-знака, как `sha256` движка); большой файл считает SubtleCrypto вне главного потока, если он есть, иначе — код движка. */
async function file_hash_async(bytes) {
  const sub = globalThis.crypto?.subtle;
  if (sub !== undefined && typeof sub.digest === 'function' && bytes instanceof Uint8Array) {
    try {
      let hex = '';
      for (const b of new Uint8Array(await sub.digest('SHA-256', bytes))) hex += b.toString(16).padStart(2, '0');
      return hex;
    } catch { /* SubtleCrypto недоступен на этой странице (нет защищённого контекста): считаем кодом движка */ }
  }
  return sha256(bytes);
}

/** Уступить главный поток: страница между стадиями успевает обработать ввод и отрисовать кадр. */
const next_task = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * То же, что `finish_csv`, но для большого файла стадии идут отдельными задачами страницы (сверка → хэш файла → отчёт), а хэш считает
 * SubtleCrypto вне главного потока. Результат тот же (проверяется тестом); для малого файла стадии идут подряд, как раньше.
 */
async function finish_csv_async(ws, input, pre, parsed, parse, big, pause) {
  const d = csv_dry(ws, input, pre, parsed);
  if (!d.ok || !big) return d.ok ? csv_plan(ws, input, pre, parsed, parse, d, sha256(pre.bytes)) : d;
  await pause();
  const hash = await file_hash_async(pre.bytes);
  await pause();
  return csv_plan(ws, input, pre, parsed, parse, d, hash);
}

/**
 * Сухой прогон CSV: разбор по профилю и сверка с рабочей областью. Рабочая область не меняется. Разбор — на главном потоке.
 * @param {object} ws
 * @param {{text: string, bytes?: Uint8Array|string, name?: string, profile: object, account_id: string, header?: string[]}} input
 *   `header` — заголовок файла (по нему разбираются колонки профиля, заданные номером, для предупреждения о единицах суммы)
 * @returns {{ok: true, plan: object} | {ok: false, error: object}} `plan.parse = {via: 'main', reason: null}`
 */
export function plan_csv(ws, input) {
  if (is_hours_profile(input.profile)) return plan_hours(ws, input); // FP-29: профиль «часы» — правки периодов, а не факты
  const pre = prepare_csv(ws, input);
  if (!pre.ok) return pre;
  let parsed;
  try { parsed = parse_with_profile(input.profile, input.text, pre.ctx); } catch (e) { return as_error(e); }
  const fx = apply_fx_rows(ws, input, pre.ctx, parsed); // FP-29: строки в чужой валюте с двумя ногами; без `input.fx` результат тот же
  if (!fx.ok) return fx;
  const done = finish_csv(ws, input, pre, fx.parsed, { via: 'main', reason: null });
  if (done.ok && fx.fx !== null) done.plan.fx = fx.fx;
  return done;
}

/**
 * То же, что `plan_csv`, но разбор файла от `WORKER_MIN_BYTES` уходит в Web Worker через `parser` (import_worker_client.mjs); без `parser`, для малого
 * файла или при сбое воркера разбор идёт на главном потоке. Результат разбора и весь план тождественны синхронному (проверяется тестами);
 * отличается только поле `plan.parse` (`via`: `'worker'` | `'main'`, `reason`: причина отката или `null`).
 * Для большого файла (от `WORKER_MIN_BYTES`) вторая половина — сверка с данными, хэш файла, отчёт — идёт отдельными задачами страницы с уступкой
 * потока между ними (`pause`), а не одной задачей.
 * @param {object} ws
 * @param {object} input как у `plan_csv`, плюс необязательные `worker_min_bytes` (порог размера, байт) и `pause` (`() => Promise`, уступка потока; по умолчанию — задача таймера)
 * @param {{parse_csv: (profile: object, text: string, ctx: object) => Promise<{result: object, via: string, reason: string|null}>}|null} [parser]
 * @returns {Promise<{ok: true, plan: object} | {ok: false, error: object}>}
 */
export async function plan_csv_async(ws, input, parser = null) {
  if (is_hours_profile(input.profile)) return plan_hours(ws, input); // FP-29: файл с часами мал и разбирается сразу
  const pre = prepare_csv(ws, input);
  if (!pre.ok) return pre;
  const big = pre.size >= (input.worker_min_bytes ?? WORKER_MIN_BYTES);
  let parsed;
  let parse = { via: 'main', reason: null };
  try {
    if (parser !== null && parser !== undefined && big) {
      const got = await parser.parse_csv(input.profile, input.text, pre.ctx);
      parsed = got.result;
      parse = { via: got.via, reason: got.reason ?? null };
    } else parsed = parse_with_profile(input.profile, input.text, pre.ctx);
  } catch (e) { return as_error(e); }
  const fx = apply_fx_rows(ws, input, pre.ctx, parsed); // FP-29 (как в `plan_csv`)
  if (!fx.ok) return fx;
  const done = await finish_csv_async(ws, input, pre, fx.parsed, parse, big, input.pause ?? next_task);
  if (done.ok && fx.fx !== null) done.plan.fx = fx.fx;
  return done;
}

// ── hledger ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const HL_TX_HEADER = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/;

/**
 * Что в hledger-журнале мастер не берёт: цена операции `@` / `@@` и проводка более чем с двумя активными ногами (`assets:` / `liabilities:`).
 * Движок `import_hledger` отказывает на первой неподдерживаемой конструкции, а `@@` пропускает молча; здесь собираются ВСЕ такие места.
 * Тексты строк в результат не попадают: только номер и причина.
 * @param {string} text
 * @returns {{line: number, reason: 'price_unit'|'price_total'|'more_than_two_assets'}[]}
 */
export function scan_hledger(text) {
  const out = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);
  let i = 0;
  while (i < lines.length) {
    const head = lines[i];
    const t = head.trim();
    if (t === '' || /^[;#*]/.test(t) || /^[ \t]/.test(head)) { i += 1; continue; }
    const dated = HL_TX_HEADER.test(t);
    const start = i + 1;
    let assets = 0;
    let anchored = false;
    i += 1;
    for (; i < lines.length && /^[ \t]+\S/.test(lines[i]); i++) {
      const body = lines[i].trim();
      if (body.startsWith(';')) continue;
      const m = /^(.*?)(?:(?:\s{2,}|\t)(.*))?$/.exec(body.replace(/\s;.*$/, ''));
      const account = m[1].trim();
      const rest = (m[2] ?? '').trim();
      if (/^(assets|liabilities):/.test(account)) assets += 1;
      if (rest.includes('=')) anchored = true;
      const price = rest.replace(/\s*==?\*?.*$/, '');
      if (price.includes('@@')) out.push({ line: i + 1, reason: 'price_total' });
      else if (price.includes('@')) out.push({ line: i + 1, reason: 'price_unit' });
    }
    if (dated && assets > 2 && !anchored) out.push({ line: start, reason: 'more_than_two_assets' });
  }
  return out;
}

function hl_reason_of(error) {
  const r = error?.ctx?.reason;
  if (typeof r === 'string' && Object.hasOwn(HL_ENGINE_REASON, r)) return HL_ENGINE_REASON[r];
  if (error?.code === 'E_NOT_INTEGER' || error?.code === 'E_OVERFLOW') return 'bad_amount';
  return 'other';
}

/** Очистка текста из файла для поля рабочей области: без управляющих знаков, NFC, не длиннее `n` знаков (по кодовым точкам). */
function clean_text(s, n) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().normalize('NFC');
  const a = [...t];
  return a.length > n ? a.slice(0, n).join('') : t;
}

/**
 * Сухой прогон hledger-журнала: отказ с перечнем «не поддержано» либо отчёт с теми же числами, что у CSV, и сводкой по счетам, якорям и курсам.
 * Переносятся: счета (новые), проводки (факты; перевод — две ноги), якоря `=`, курсы `P`. Периодические правила `~` и разовые планы
 * в рабочую область мастером не вносятся — они называются в отчёте строкой «найдено, не перенесено».
 * @param {object} ws
 * @param {{text: string, bytes?: Uint8Array|string, name?: string}} input
 * @returns {{ok: true, plan: object} | {ok: false, error: object, unsupported?: {line: number|null, reason: string}[]}}
 */
export function plan_hledger(ws, input) {
  if (!is_obj(ws) || typeof ws.as_of !== 'string') return refuse('no_workspace');
  if (typeof input.text !== 'string') return refuse('text_not_string');
  const bytes = input.bytes ?? input.text;
  const size = typeof bytes === 'string' ? new TextEncoder().encode(bytes).length : bytes.length;
  const sz = check_size(size);
  if (!sz.ok) return sz;
  const unsupported = scan_hledger(input.text);
  let st = null;
  try { st = import_hledger(input.text); } catch (e) {
    const er = err_of(e);
    const line = typeof er.ctx.line === 'number' ? er.ctx.line : null;
    if (line === null || !unsupported.some((u) => u.line === line)) unsupported.push({ line, reason: hl_reason_of(er) });
  }
  if (unsupported.length > 0) {
    unsupported.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'unsupported_constructs', count: unsupported.length } }, unsupported: unsupported.slice(0, 200) };
  }
  const as_of = to_epoch_day(ws.as_of);

  // счета: используем существующий с тем же идентификатором и валютой, иначе создаём новый
  const have = new Map(list(ws, 'accounts').filter(is_obj).map((a) => [a.account_id, a]));
  const acc_state = new Map();
  const accounts_new = [];
  for (const a of Object.values(st.accounts)) {
    const ex = have.get(a.account_id);
    if (ex !== undefined) { acc_state.set(a.account_id, ex.currency === a.currency ? 'reuse' : 'conflict'); continue; }
    if (id_taken_elsewhere(ws, a.account_id, 'account')) { acc_state.set(a.account_id, 'conflict'); continue; }
    acc_state.set(a.account_id, 'new');
    accounts_new.push({
      account_id: a.account_id, name: clean_text(a.name, 120) || a.account_id, kind: a.kind, liquidity: a.liquidity, currency: a.currency,
      exponent: a.exponent, liquidity_bp: 0,
    });
  }

  // проводки → кандидаты в том же виде, что у CSV
  const rejects = [];
  const cands = [];
  const seen = new Map();
  const legs = new Map(); // transfer_id → [row]
  const add_leg = (ref, n, rejected) => { if (typeof ref === 'string') (legs.get(ref) ?? legs.set(ref, []).get(ref)).push({ row: n, rejected }); };
  let row = 0;
  for (const f of Object.values(st.facts)) {
    row += 1;
    if (acc_state.get(f.account_id) === 'conflict') { rejects.push({ row, reason: have.has(f.account_id) ? 'currency_mismatch' : 'account_conflict' }); add_leg(f.transfer_id, row, true); continue; }
    const day = to_epoch_day(f.date);
    if (day > as_of) { rejects.push({ row, reason: 'future_date' }); add_leg(f.transfer_id, row, true); continue; }
    const desc = clean_text(f.note, 500);
    const g = f.account_id + '|' + day + '|' + f.amount_minor + '|' + f.currency + '|' + norm(desc);
    const k = seen.get(g) ?? 0;
    seen.set(g, k + 1);
    const cand = {
      row, account_id: f.account_id, date: day, amount_minor: f.amount_minor, currency: f.currency, desc, tag: typeof f.tag === 'string' && f.tag !== '' ? clean_text(f.tag, 100) : null, k,
      dedup_key: dedup_key(f.account_id, day, f.amount_minor, f.currency, desc, k),
    };
    if (typeof f.transfer_id === 'string') { cand.transfer_ref = f.transfer_id; add_leg(f.transfer_id, row, false); }
    cands.push(cand);
  }

  // перевод — единое целое: если одна нога отклонена, вторая тоже
  let cleaned = cands;
  const drop_half = (rows) => {
    const moved = cleaned.filter((c) => rows.has(c.row));
    for (const c of moved) rejects.push({ row: c.row, reason: 'transfer_half' });
    cleaned = cleaned.filter((c) => !rows.has(c.row));
  };
  const half = new Set();
  for (const ls of legs.values()) if (ls.some((l) => l.rejected)) for (const l of ls) if (!l.rejected) half.add(l.row);
  if (half.size > 0) drop_half(half);

  let dry;
  try { dry = run_dry(ws, cleaned, rejects); } catch (e) { return as_error(e); }
  // одна нога перевода уже в данных (дубликат), другой там нет — вторую не записываем: перевод остался бы одноногим
  const dup_rows = new Set(dry.duplicate_items.map((c) => c.row));
  const half2 = new Set();
  const by_ref = new Map();
  for (const c of cleaned) if (c.transfer_ref !== undefined) (by_ref.get(c.transfer_ref) ?? by_ref.set(c.transfer_ref, []).get(c.transfer_ref)).push(c);
  for (const ls of by_ref.values()) {
    const d = ls.filter((c) => dup_rows.has(c.row)).length;
    if (d > 0 && d < ls.length) for (const c of ls) if (!dup_rows.has(c.row)) half2.add(c.row);
  }
  if (half2.size > 0) {
    drop_half(half2);
    try { dry = run_dry(ws, cleaned, rejects); } catch (e) { return as_error(e); }
  }
  const pairs = new Map(); // transfer_ref → [row, row]
  for (const c of cleaned) if (c.transfer_ref !== undefined) (pairs.get(c.transfer_ref) ?? pairs.set(c.transfer_ref, []).get(c.transfer_ref)).push(c.row);

  // якоря и курсы: новые, уже есть, конфликт идентификатора
  const anchors_new = [];
  const anchor_count = { new: 0, exists: 0, rejected: 0 };
  const have_anchor = new Map(list(ws, 'anchors').filter(is_obj).map((a) => [a.anchor_id, a]));
  for (const a of Object.values(st.anchors)) {
    const ex = have_anchor.get(a.anchor_id);
    const same = (x) => x.account_id === a.account_id && x.date === a.date && x.amount_minor === a.amount_minor;
    if (ex !== undefined) { if (same(ex)) anchor_count.exists += 1; else anchor_count.rejected += 1; continue; }
    if (acc_state.get(a.account_id) === 'conflict' || to_epoch_day(a.date) > as_of || id_taken_elsewhere(ws, a.anchor_id, 'anchor')) { anchor_count.rejected += 1; continue; }
    anchors_new.push({ anchor_id: a.anchor_id, account_id: a.account_id, date: a.date, amount_minor: a.amount_minor });
    anchor_count.new += 1;
  }
  const rates_new = [];
  const rate_count = { new: 0, exists: 0, rejected: 0 };
  const have_rate = new Map(list(ws, 'rates').filter(is_obj).map((r) => [r.fx_id, r]));
  for (const r of Object.values(st.fx)) {
    const ex = have_rate.get(r.fx_id);
    if (ex !== undefined) { if (ex.base === r.base && ex.quote === r.quote && ex.date === r.date && ex.num === r.num && ex.den === r.den) rate_count.exists += 1; else rate_count.rejected += 1; continue; }
    rates_new.push({ fx_id: r.fx_id, date: r.date, base: r.base, quote: r.quote, num: r.num, den: r.den, source: 'manual' });
    rate_count.new += 1;
  }
  const extras = {
    accounts_new, accounts_reused: [...acc_state.values()].filter((s) => s === 'reuse').length, anchors_new, rates_new,
    counts: { accounts_new: accounts_new.length, anchors: anchor_count, rates: rate_count, rules_found: Object.keys(st.rules).length, plans_found: Object.keys(st.plans).length },
  };
  const plan = {
    kind: 'hledger', base_ws: ws, account_id: null, currency: null, profile_id: 'hledger',
    source: { name: clip(input.name ?? '', 120), size, bytes, hash: sha256(bytes) },
    candidates: cleaned, dry, report: make_report(dry, rejects, ws), pairs, extras, unsupported: [],
  };
  return { ok: true, plan };
}

// ── решения о двойниках и запись партии ──────────────────────────────────────────────────────────────────────────

/**
 * Какие распознанные строки пойдут в запись при решениях `decisions` (`{номер строки: 'accept'|'skip'}`).
 * Возможный двойник по умолчанию пропускается; перевод hledger записывается целиком или не записывается: если одна из его ног — двойник
 * и не принята, пропускаются обе.
 */
export function select_items(plan, decisions = {}) {
  const accepted = (row) => (decisions instanceof Map ? decisions.get(row) : decisions?.[row]) === 'accept';
  const skip_pair = new Set();
  for (const [ref, rows] of plan.pairs) {
    const legs = plan.dry.recognized_items.filter((c) => rows.includes(c.row));
    if (legs.some((c) => c.double !== null && c.double !== undefined && !accepted(c.row))) skip_pair.add(ref);
  }
  return plan.dry.recognized_items.filter((c) => {
    if (c.transfer_ref !== undefined && skip_pair.has(c.transfer_ref)) return false;
    return c.double === null || c.double === undefined || accepted(c.row);
  });
}

/** Сколько фактов запишет «Подтвердить» при решениях `decisions`. */
export function importable_count(plan, decisions = {}) {
  if (plan.kind === 'hours') return hours_importable(plan); // FP-29: периоды часов
  return select_items(plan, decisions).length;
}

/** План прежний: рабочая область с тех пор не менялась (иначе отчёт мог устареть). */
export function plan_is_current(plan, ws) {
  return plan.base_ws === ws;
}

/** Хэш состояния, свёрнутого из рабочей области (до «Подтвердить» не меняется; после отката партии возвращается к прежнему). */
export function ws_state_hash(ws) {
  return state_hash(ws_to_state(ws));
}

/** Первая ошибка проверки результата, которой не было до записи (E_SCHEMA и др. коды REQ-017), либо `null`. */
function new_validation_error(before, after) {
  const r = validate_ws(after);
  if (r.ok) return null;
  const b = validate_ws(before);
  if (r.errors.length <= b.errors.length) return null;
  const e = r.errors[0];
  return { code: e.code, ctx: { reason: 'validation_failed', field: clip(e.field ?? '', 40), detail: clip(e.reason ?? '', 40) } };
}

/**
 * Запись партии: рабочая область + факты (и для hledger новые счета, якоря, курсы). Рабочая область не мутируется.
 * Все факты партии несут `batch_id` и `dedup_key`: по ним находятся откат партии и повторный импорт без дублей (REQ-093).
 * @param {object} ws текущая рабочая область (план строился по ней)
 * @param {object} plan результат `plan_csv` / `plan_hledger`
 * @param {Record<number, 'accept'|'skip'>} decisions решения по двойникам
 * @param {{new_id: (prefix: string) => string}} env
 * @returns {{ok: true, ws: object, batch: object, events: object[]} | {ok: false, error: object}}
 */
export function commit_plan(ws, plan, decisions, env) {
  if (plan?.kind === 'hours') return commit_hours(ws, plan, env); // FP-29: правки периодов часов и запись партии, не факты
  if (!is_obj(ws) || typeof ws.as_of !== 'string') return refuse('no_workspace');
  if (!plan_is_current(plan, ws)) return refuse('stale_plan');
  const items = select_items(plan, decisions);
  const x = plan.extras;
  const extra_n = x === null ? 0 : x.accounts_new.length + x.anchors_new.length + x.rates_new.length;
  if (items.length === 0 && extra_n === 0) return refuse('nothing_to_import');
  const batch_id = env.new_id('imp');
  const dec = {};
  for (const c of items) if (c.double !== null && c.double !== undefined) dec[c.row] = 'accept';
  let seq = 0;
  let first = true;
  let events;
  try {
    events = import_commit({ ...plan.dry, recognized_items: items }, dec, plan.source.bytes, {
      batch_id, profile_id: plan.profile_id,
      next_id: () => { if (first) { first = false; return env.new_id('evt'); } return env.new_id('tx'); },
      next_seq: () => { seq += 1; return seq; },
      recorded_at: ws.as_of + 'T00:00:00Z',
    });
  } catch (e) { return as_error(e); }
  const by_key = new Map(plan.candidates.map((c) => [c.dedup_key, c]));
  const trf = new Map();
  const taken = new Set(list(ws, 'facts').map((f) => f?.event_id));
  const facts = [];
  // Контрагенты файла Runway (REQ-095, FP-47): имя из ячейки — недоверенный текст (`clean_text`); контрагент с таким именем уже есть — берётся его `counterparty_id`,
  // иначе партия заводит нового (его убирает откат партии, если на него больше никто не ссылается).
  const cp_ids = new Map();
  for (const cp of list(ws, 'counterparties')) {
    if (is_obj(cp) && typeof cp.name === 'string' && typeof cp.counterparty_id === 'string') {
      const key = clean_text(cp.name, 120);
      if (!cp_ids.has(key)) cp_ids.set(key, cp.counterparty_id);
    }
  }
  const cp_new = [];
  const cp_id_of = (name) => {
    if (!cp_ids.has(name)) {
      const id = env.new_id('cp');
      cp_ids.set(name, id);
      cp_new.push({ counterparty_id: id, name, batch_id }); // `batch_id`, как у фактов партии: откат найдёт контрагента и после перезагрузки страницы
    }
    return cp_ids.get(name);
  };
  for (const e of events.slice(1)) {
    const p = e.payload;
    const c = by_key.get(p.dedup_key);
    const fact = { event_id: e.entity_id, account_id: p.account_id, date: p.date, amount_minor: p.amount_minor, currency: p.currency, kind: p.amount_minor > 0 ? 'income' : 'expense' };
    if (typeof p.tag === 'string' && p.tag !== '') fact.tag = clean_text(p.tag, 100);
    const note = clean_text(p.note, 500);
    if (note !== '') fact.note = note;
    const cp_name = typeof c?.counterparty === 'string' ? clean_text(c.counterparty, 120) : '';
    if (cp_name !== '') fact.counterparty_id = cp_id_of(cp_name);
    fact.dedup_key = p.dedup_key;
    fact.batch_id = batch_id;
    if (c?.transfer_ref !== undefined) {
      if (!trf.has(c.transfer_ref)) trf.set(c.transfer_ref, env.new_id('trf'));
      fact.kind = 'transfer';
      fact.transfer_id = trf.get(c.transfer_ref);
    }
    // FP-29: строка в чужой валюте с двумя ногами — обмен: две ноги одного перевода, выведенный курс (`fx`) лежит на проданной ноге, как у формы обмена (FP-08);
    // ключ строки (`dedup_key`) остался на ноге счёта импорта — по нему повторный импорт даёт дубликат, у второй ноги ключа нет
    let second = null;
    if (is_obj(c?.exchange)) {
      const [own, other] = exchange_legs(c);
      const trf_id = env.new_id('trf');
      fact.kind = 'transfer';
      fact.transfer_id = trf_id;
      if (own.fx !== undefined) fact.fx = { ...own.fx };
      second = { event_id: env.new_id('tx'), account_id: other.account_id, date: p.date, amount_minor: other.amount_minor, currency: other.currency, kind: 'transfer', transfer_id: trf_id };
      if (other.fx !== undefined) second.fx = { ...other.fx };
      if (note !== '') second.note = note;
      second.batch_id = batch_id;
      if (taken.has(second.event_id) || !is_valid_id(second.event_id)) return refuse('duplicate_id');
      taken.add(second.event_id);
    }
    if (taken.has(fact.event_id) || !is_valid_id(fact.event_id)) return refuse('duplicate_id');
    taken.add(fact.event_id);
    facts.push(fact);
    if (second !== null) facts.push(second);
  }
  const after = { ...ws, facts: [...list(ws, 'facts'), ...facts] };
  if (cp_new.length > 0) after.counterparties = [...list(ws, 'counterparties'), ...cp_new];
  if (x !== null) {
    if (x.accounts_new.length > 0) after.accounts = [...list(ws, 'accounts'), ...x.accounts_new.map((a) => ({ ...a }))];
    if (x.anchors_new.length > 0) after.anchors = [...list(ws, 'anchors'), ...x.anchors_new.map((a) => ({ ...a }))];
    if (x.rates_new.length > 0) after.rates = [...list(ws, 'rates'), ...x.rates_new.map((r) => ({ ...r }))];
  }
  const bad = new_validation_error(ws, after);
  if (bad !== null) return { ok: false, error: bad };
  const batch = {
    batch_id, facts: facts.length, profile_id: plan.profile_id, source_hash: events[0].payload.source_hash,
    ...(cp_new.length === 0 ? {} : { counterparties: cp_new.map((c) => c.counterparty_id) }),
    accounts: x === null ? [] : x.accounts_new.map((a) => a.account_id), anchors: x === null ? [] : x.anchors_new.map((a) => a.anchor_id), rates: x === null ? [] : x.rates_new.map((r) => r.fx_id),
  };
  return { ok: true, ws: after, batch, events };
}

/** Партии импорта, найденные в рабочей области по `batch_id` фактов: `[{batch_id, count, from, to, net_minor, currency}]` в порядке первого появления. */
export function list_batches(ws) {
  const m = new Map();
  for (const f of list(ws, 'facts')) {
    if (!is_obj(f) || typeof f.batch_id !== 'string') continue;
    let b = m.get(f.batch_id);
    if (b === undefined) { b = { batch_id: f.batch_id, count: 0, from: null, to: null, net_minor: 0, currency: f.currency ?? null }; m.set(f.batch_id, b); }
    b.count += 1;
    if (typeof f.date === 'string') { if (b.from === null || f.date < b.from) b.from = f.date; if (b.to === null || f.date > b.to) b.to = f.date; }
    if (Number.isSafeInteger(f.amount_minor)) b.net_minor += f.amount_minor;
    if (b.currency !== f.currency) b.currency = null; // разные валюты — суммы не складываем
  }
  return [...m.values()];
}

function references_account(ws, id) {
  for (const k of ['facts', 'anchors', 'plans', 'rules', 'streams', 'debts']) if (list(ws, k).some((x) => x?.account_id === id)) return true;
  return list(ws, 'reserves').some((r) => r?.backed_by_account_id === id);
}

/** На контрагента ссылается хотя бы одна запись (факт, план, правило, поток, долг). */
function references_counterparty(ws, id) {
  return ['facts', 'plans', 'rules', 'streams', 'debts'].some((k) => list(ws, k).some((x) => x?.counterparty_id === id));
}

/**
 * Откат партии: убирает факты с этим `batch_id` (и, если переданы в `extra`, внесённые партией счета, якоря, курсы и контрагентов; счёт и контрагент с записями остаются).
 * Остальные записи не трогаются, поэтому откат возвращает состояние к значению до импорта, если после импорта ничего другого не менялось.
 * @param {object} ws
 * @param {string} batch_id
 * @param {{accounts?: string[], anchors?: string[], rates?: string[], counterparties?: string[]}} [extra] что ещё внесла партия (из результата `commit_plan`)
 * @returns {{ok: true, ws: object, removed: {facts: number, accounts: number, anchors: number, rates: number, counterparties?: number}} | {ok: false, error: object}}
 */
export function rollback_batch(ws, batch_id, extra = {}) {
  if (!is_obj(ws)) return refuse('no_workspace');
  if (!is_valid_id(batch_id)) return refuse('unknown_batch');
  const facts = list(ws, 'facts');
  const rest = facts.filter((f) => f?.batch_id !== batch_id);
  const anchor_ids = new Set(extra.anchors ?? []);
  const rate_ids = new Set(extra.rates ?? []);
  const acc_ids = new Set(extra.accounts ?? []);
  const anchors = list(ws, 'anchors').filter((a) => !anchor_ids.has(a?.anchor_id));
  const rates = list(ws, 'rates').filter((r) => !rate_ids.has(r?.fx_id));
  const removed = { facts: facts.length - rest.length, anchors: list(ws, 'anchors').length - anchors.length, rates: list(ws, 'rates').length - rates.length, accounts: 0 };
  if (removed.facts === 0 && removed.anchors === 0 && removed.rates === 0 && acc_ids.size === 0) return refuse('unknown_batch');
  const after = { ...ws };
  if (removed.facts > 0) after.facts = rest;
  if (removed.anchors > 0) after.anchors = anchors;
  if (removed.rates > 0) after.rates = rates;
  if (acc_ids.size > 0) {
    const accounts = list(ws, 'accounts').filter((a) => !(acc_ids.has(a?.account_id) && !references_account(after, a.account_id)));
    removed.accounts = list(ws, 'accounts').length - accounts.length;
    if (removed.accounts > 0) after.accounts = accounts;
  }
  const cp_ids = new Set(extra.counterparties ?? []);
  { // контрагенты, заведённые партией (REQ-095): уходят вместе с её фактами, если на них больше никто не ссылается; их находят по `batch_id` или по списку партии
    const mine = (c) => cp_ids.has(c?.counterparty_id) || c?.batch_id === batch_id;
    const cps = list(ws, 'counterparties').filter((c) => !(mine(c) && !references_counterparty(after, c.counterparty_id)));
    const n = list(ws, 'counterparties').length - cps.length;
    if (n > 0) { after.counterparties = cps; removed.counterparties = n; }
  }
  return { ok: true, ws: after, removed };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Состояние мастера (чистые переходы: экран хранит один объект `w` и вызывает эти функции; DOM здесь не нужен)
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Поля сопоставления колонок, которые пользователь может менять (`wiz_csv_set`). */
export const MAPPING_FIELDS = Object.freeze([
  'date_col', 'date_fmt', 'amount_mode', 'amount_unit', 'amount_col', 'debit_col', 'credit_col', 'decimal', 'thousands', 'currency_mode', 'currency_col', 'desc_cols', 'rules_text',
]);

/** Вкладки мастера. */
export const TABS = Object.freeze(['csv', 'hledger']);

/** Новое состояние мастера: две вкладки, у каждой свой шаг; `batches` — партии этой сессии (что ещё внесла партия, кроме фактов). */
export function new_wizard() {
  return {
    tab: 'csv',
    csv: {
      step: 'file', file: null, encoding: 'utf-8', delimiter: 'auto', skip: 0, text: null, sniff: null, mapping: null, recommended: null,
      profile_choice: 'custom', profile_file: null, account_id: null, plan: null, decisions: {}, error: null, result: null, mapping_edited: false,
      run_seq: 0, checking: false, // номер последнего запуска сухого прогона и признак «идёт разбор в фоне» (`wiz_csv_run_async`)
      v11: new_v11_state(), // FP-29: поток для часов, строки обмена (колонки второй ноги, счёт второй ноги)
    },
    hledger: { step: 'file', file: null, plan: null, unsupported: [], decisions: {}, error: null, result: null },
    batches: {},
  };
}

/** Сбросить вкладку к первому шагу (файл, профиль и результаты забываются; партии сессии остаются). */
export function wiz_reset(w, tab) {
  const fresh = new_wizard();
  w[tab] = fresh[tab];
  return w;
}

const set_error = (st, r) => { st.error = r.ok ? null : r.error; return r; };

/** Любое изменение входных данных CSV делает незавершённый фоновый прогон устаревшим: его результат будет отброшен. */
const invalidate_run = (st) => { st.run_seq += 1; st.checking = false; };

/**
 * CSV: принять файл. Размер проверяется ДО чтения содержимого в текст (REQ-091); дальше — кодировка, разделитель, образец, догадка о колонках.
 * @param {object} w состояние
 * @param {object} ws
 * @param {{name: string, bytes: Uint8Array}} file
 */
export function wiz_csv_load(w, ws, file) {
  const st = w.csv;
  invalidate_run(st);
  st.plan = null; st.result = null; st.decisions = {}; st.step = 'file';
  const sz = check_size(file?.bytes?.length ?? Infinity);
  if (!sz.ok) { st.file = null; st.text = null; st.sniff = null; return set_error(st, sz); }
  st.file = { name: clip(file.name ?? '', 120), bytes: file.bytes };
  st.mapping = null; st.profile_file = null; st.mapping_edited = false;
  return wiz_csv_resniff(w, ws);
}

/** CSV: заново прочитать образец (после смены кодировки, разделителя или числа строк преамбулы). */
export function wiz_csv_resniff(w, ws) {
  const st = w.csv;
  if (st.file === null) return set_error(st, refuse('no_header_row'));
  const d = decode_bytes(st.file.bytes, st.encoding);
  if (!d.ok) return set_error(st, d);
  st.text = d.text;
  const sn = sniff_csv(d.text, { delimiter: st.delimiter, skip: st.skip });
  if (!sn.ok) { st.sniff = null; return set_error(st, sn); }
  st.sniff = sn;
  st.recommended = recommend_profile(sn) ?? recommend_v11_profile(sn); // FP-29: профиль «часы» и профиль строк обмена узнаются по заголовку
  const keep = st.mapping;
  st.mapping = suggest_mapping(sn, { skip: st.skip, encoding: st.encoding });
  if (keep !== null && st.mapping_edited) {
    // пользователь уже правил колонки: не затираем, если колонка есть в новом заголовке
    for (const k of MAPPING_FIELDS) if (keep[k] !== undefined && (!k.endsWith('_col') || keep[k] < sn.header.length)) st.mapping[k] = keep[k];
  }
  if (!['custom', 'file'].includes(st.profile_choice) && !Object.hasOwn(BUILTIN_PROFILES, st.profile_choice) && !is_v11_profile_id(st.profile_choice)) st.profile_choice = 'custom';
  if (st.profile_choice === 'custom' && st.recommended !== null && keep === null) st.profile_choice = st.recommended;
  if (st.recommended === null && (Object.hasOwn(BUILTIN_PROFILES, st.profile_choice) || is_v11_profile_id(st.profile_choice))) st.profile_choice = 'custom'; // выбранный встроенный профиль файлу не подходит
  if (st.account_id === null || open_account(ws, st.account_id) === null) st.account_id = default_import_account(ws);
  st.step = 'columns';
  return set_error(st, { ok: true });
}

/**
 * CSV: изменить настройку шага «колонки». `patch` — любые из: `encoding`, `delimiter`, `skip`, `profile_choice`, `account_id` и поля сопоставления.
 * Значения проверяются; неизвестные ключи игнорируются (в состояние не попадает ничего, кроме перечисленного).
 */
export function wiz_csv_set(w, ws, patch) {
  const st = w.csv;
  invalidate_run(st);
  let resniff = false;
  for (const [k, v] of Object.entries(is_obj(patch) ? patch : {})) {
    if (k === 'encoding' && ENCODINGS.includes(v)) { st.encoding = v; resniff = true; }
    else if (k === 'delimiter' && ['auto', ',', ';', '\t'].includes(v)) { st.delimiter = v; resniff = true; }
    else if (k === 'skip' && Number.isInteger(v) && v >= 0 && v <= 50) { st.skip = v; resniff = true; }
    else if (k === 'profile_choice' && (v === 'custom' || (v === 'file' && st.profile_file !== null) || Object.hasOwn(BUILTIN_PROFILES, v) || is_v11_profile_id(v))) st.profile_choice = v;
    else if (V11_KEYS.includes(k)) v11_patch(st.v11, ws, k, v); // FP-29
    else if (k === 'account_id' && typeof v === 'string' && open_account(ws, v) !== null) st.account_id = v;
    else if (MAPPING_FIELDS.includes(k) && st.mapping !== null) {
      st.mapping[k] = v; st.mapping_edited = true;
      if (k === 'amount_mode' && v === 'debit_credit' && st.mapping.amount_unit === 'minor') st.mapping.amount_unit = 'major'; // минимальные единицы — только для одной колонки со знаком
    }
  }
  st.plan = null; st.result = null;
  if (resniff) return wiz_csv_resniff(w, ws);
  st.step = 'columns';
  return { ok: true };
}

/** CSV: профиль из файла пользователя (недоверенный JSON): принят или отвергнут целиком; принятый становится выбором «из файла». */
export function wiz_csv_profile_file(w, ws, text) {
  const st = w.csv;
  invalidate_run(st);
  const r = read_profile_text(text);
  if (!r.ok) return set_error(st, r);
  st.profile_file = r.profile;
  st.profile_choice = 'file';
  const enc = r.profile.encoding ?? 'utf-8';
  if (st.file !== null && enc !== st.encoding) { st.encoding = enc; return wiz_csv_resniff(w, ws); }
  st.plan = null; st.error = null;
  return { ok: true };
}

/** Профиль, по которому пойдёт разбор: встроенный, из файла или собранный из сопоставления колонок. */
export function wiz_csv_profile(w, ws) {
  const st = w.csv;
  if (Object.hasOwn(BUILTIN_PROFILES, st.profile_choice)) {
    const p = clone(BUILTIN_PROFILES[st.profile_choice]);
    if (DELIMITER_FREE.has(st.profile_choice) && st.sniff !== null) p.delimiter = st.sniff.delimiter; // файл, пересохранённый в таблице: разделитель другой, колонки те же
    return { ok: true, profile: p };
  }
  if (is_v11_profile_id(st.profile_choice)) { const r = v11_profile(st.profile_choice, st.sniff); return { ok: true, profile: r.profile, fx: r.fx }; } // FP-29
  if (st.profile_choice === 'file' && st.profile_file !== null) {
    if (has_fx_block(st.profile_file)) { const { fx, ...base } = clone(st.profile_file); return { ok: true, profile: base, fx }; } // FP-29: профиль из файла с блоком fx
    return { ok: true, profile: clone(st.profile_file) };
  }
  const acc = open_account(ws, st.account_id);
  if (st.sniff === null || st.mapping === null) return refuse('no_header_row');
  return build_profile({ ...st.mapping, delimiter: st.sniff.delimiter, skip: st.skip, encoding: st.encoding }, st.sniff, acc ?? {});
}

/** CSV: «Назад» из отчёта к колонкам: отчёт убирается, незавершённый фоновый прогон отбрасывается (иначе он вернул бы отчёт на экран). */
export function wiz_csv_back(w) {
  const st = w.csv;
  invalidate_run(st);
  st.step = 'columns'; st.plan = null;
}

/** Входные данные сухого прогона CSV из состояния мастера или отказ (профиль не собран, файла нет). */
function csv_run_input(w, ws) {
  const st = w.csv;
  if (st.file === null || st.text === null) return set_error(st, refuse('no_header_row'));
  const p = wiz_csv_profile(w, ws);
  if (!p.ok) { st.plan = null; return set_error(st, p); }
  const x = v11_run_extra(st.v11, ws, p, st); // FP-29: поток часов или блок обмена
  if (!x.ok) { st.plan = null; return set_error(st, x); }
  return { ok: true, input: { text: st.text, bytes: st.file.bytes, name: st.file.name, profile: p.profile, account_id: st.account_id, header: st.sniff?.header, ...x.extra } };
}

/** Принять результат сухого прогона CSV в состояние мастера. */
function csv_run_apply(st, r) {
  if (!r.ok) { st.plan = null; return set_error(st, r); }
  st.plan = r.plan; st.decisions = {}; st.step = 'report'; st.error = null; st.result = null;
  return r;
}

/** CSV: сухой прогон по выбранному профилю → шаг «отчёт». Рабочая область не меняется. Разбор — на главном потоке. */
export function wiz_csv_run(w, ws) {
  const st = w.csv;
  invalidate_run(st);
  const pr = csv_run_input(w, ws);
  if (!pr.ok) return pr;
  return csv_run_apply(st, plan_csv(ws, pr.input));
}

/**
 * CSV: сухой прогон с разбором большого файла в фоне (`plan_csv_async`). Пока идёт разбор, `csv.checking = true`; результат принимается, только
 * если за это время не менялись файл, профиль и настройки (иначе `{ok: false, cancelled: true}`, состояние не трогается).
 * @param {object} w
 * @param {object} ws
 * @param {object|null} parser клиент воркера разбора (import_worker_client.mjs) или `null`
 * @param {{keep_decisions?: object}} [opts] `keep_decisions` — решения о двойниках, которые нужно сохранить (пересчёт устаревшего отчёта)
 * @returns {Promise<{ok: true, plan: object} | {ok: false, error?: object, cancelled?: true}>}
 */
export async function wiz_csv_run_async(w, ws, parser, opts = {}) {
  const st = w.csv;
  invalidate_run(st);
  const token = st.run_seq;
  const pr = csv_run_input(w, ws);
  if (!pr.ok) return pr;
  st.checking = true;
  let r;
  try { r = await plan_csv_async(ws, pr.input, parser); } catch (e) { r = as_error(e); } // не оставлять экран в «Проверяю» при неожиданном сбое
  if (w.csv !== st || st.run_seq !== token) return { ok: false, cancelled: true };
  st.checking = false;
  const out = csv_run_apply(st, r);
  if (out.ok && opts.keep_decisions !== undefined) st.decisions = opts.keep_decisions;
  return out;
}

/** hledger: принять файл и сделать сухой прогон; отказ с перечнем «не поддержано» остаётся в `hledger.unsupported`. */
export function wiz_hl_load(w, ws, file) {
  const st = w.hledger;
  st.plan = null; st.result = null; st.decisions = {}; st.unsupported = []; st.step = 'file';
  const sz = check_size(file?.bytes?.length ?? Infinity);
  if (!sz.ok) { st.file = null; return set_error(st, sz); }
  st.file = { name: clip(file.name ?? '', 120), bytes: file.bytes };
  const d = decode_bytes(file.bytes, 'utf-8');
  if (!d.ok) return set_error(st, d);
  const r = plan_hledger(ws, { text: d.text, bytes: file.bytes, name: st.file.name });
  if (!r.ok) { st.unsupported = r.unsupported ?? []; st.step = 'report'; return set_error(st, r); }
  st.plan = r.plan; st.step = 'report'; st.error = null;
  return r;
}

/** План устарел (рабочая область менялась) — пересчитать по тем же входным данным; решения о двойниках сохраняются. */
export function wiz_refresh(w, tab, ws) {
  const st = w[tab];
  if (st.plan === null || st.step !== 'report' || plan_is_current(st.plan, ws)) return false;
  const keep = st.decisions;
  if (tab === 'csv') wiz_csv_run(w, ws); else wiz_hl_load(w, ws, st.file);
  st.decisions = keep;
  return true;
}

/**
 * То же, что `wiz_refresh` для вкладки CSV, но с разбором в фоне: `null`, если пересчёт не нужен (плана нет, он свежий или уже идёт пересчёт).
 * Решения о двойниках сохраняются.
 */
export function wiz_refresh_async(w, ws, parser) {
  const st = w.csv;
  if (st.plan === null || st.step !== 'report' || st.checking || plan_is_current(st.plan, ws)) return null;
  return wiz_csv_run_async(w, ws, parser, { keep_decisions: st.decisions });
}

/** Решение по двойнику: `accept` или `skip`. */
export function wiz_decide(w, tab, row, decision) {
  if (!Number.isInteger(row) || !['accept', 'skip'].includes(decision)) return false;
  w[tab].decisions[row] = decision;
  return true;
}

/**
 * «Подтвердить»: новая рабочая область для `ctx.set_ws` (экран записывает её общим путём) или отказ. Состояние мастера не меняется —
 * итог фиксирует `wiz_committed` уже после успешной записи.
 */
export function wiz_commit(w, tab, ws, env) {
  const st = w[tab];
  if (st.plan === null) return refuse('nothing_to_import');
  return commit_plan(ws, st.plan, st.decisions, env);
}

/** Партия записана: запомнить её (для отката), перейти к шагу «готово». */
export function wiz_committed(w, tab, batch) {
  const st = w[tab];
  w.batches[batch.batch_id] = batch;
  st.result = { batch_id: batch.batch_id, facts: batch.facts, kind: tab, ...(batch.what === undefined ? {} : { what: batch.what }) }; // `what`: 'hours' — партия часов (FP-29)
  st.step = 'done'; st.plan = null; st.error = null;
}

/** «Откатить партию»: новая рабочая область без фактов партии (и без счетов, якорей, курсов, внесённых ею). */
export function wiz_rollback(w, ws, batch_id) {
  if (is_hours_batch(ws, batch_id)) return rollback_hours(ws, batch_id); // FP-29: партия часов хранится в данных, откат работает и после перезагрузки
  const b = Object.hasOwn(w.batches, batch_id) ? w.batches[batch_id] : undefined;
  return rollback_batch(ws, batch_id, b === undefined ? {} : { accounts: b.accounts, anchors: b.anchors, rates: b.rates, counterparties: b.counterparties });
}
