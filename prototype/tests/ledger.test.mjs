// ledger.test.mjs — SHA-256 (сверка с node:crypto), canon, TST-33 (детерминизм inputs_hash), TST-38 (state_hash round-trip, часть),
// TST-32 (идемпотентность отката/свёртки, часть), TST-42 (dedup_key), журнал: make_event / effective_events / reduce / upcast / state_at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto'; // только в ТЕСТЕ — оракул для чистой реализации sha256
import {
  sha256, canon, inputs_hash, state_hash, make_event, effective_events, reduce, upcast, dedup_key, norm, state_at,
  empty_state, EVENT_TYPES, DEFAULT_UPCAST_REGISTRY,
} from '../engine/ledger.mjs';
import { parse_minor } from '../engine/money.mjs';
import { format_date, parse_date } from '../engine/dates.mjs';
import { g001_rules, make_rng, throws_code } from './helpers.mjs';

const node_sha = (data) => createHash('sha256').update(data).digest('hex');

// ── SHA-256 ───────────────────────────────────────────────────────────────────

test('sha256: векторы NIST и сверка с node:crypto', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256('a'.repeat(1_000_000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  assert.equal(sha256(new Uint8Array([0x61, 0x62, 0x63])), sha256('abc'), 'Uint8Array = строка в UTF-8');
  assert.equal(sha256([0x61, 0x62, 0x63]), sha256('abc'), 'массив байтов');
});

test('sha256: границы дополнения (длины 0…200, 55/56/57/63/64/65/119/120/121) против node:crypto', () => {
  const rng = make_rng(256);
  const lens = [...Array.from({ length: 201 }, (_, i) => i), 255, 256, 257, 1000, 4096, 10000];
  for (const len of lens) {
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = rng.int(0, 255);
    assert.equal(sha256(buf), node_sha(buf), `длина ${len}`);
  }
});

test('sha256: строки в UTF-8 (кириллица, эмодзи, нормализация не применяется) против node:crypto', () => {
  for (const s of ['Привет, мир', '€ 1 234,56', '日本語', '😀 emoji', 'é vs é', 'line\nbreak\r\n', '\u0000nul']) {
    assert.equal(sha256(s), node_sha(Buffer.from(s, 'utf8')), s);
  }
  throws_code(() => sha256(123), 'E_SCHEMA');
  throws_code(() => sha256(null), 'E_SCHEMA');
});

// ── canon ─────────────────────────────────────────────────────────────────────

test('canon: ключи по кодовым точкам, без пробелов, NFC, массивы как есть', () => {
  assert.equal(canon({ b: 1, a: [3, 2, 1], c: { z: null, y: true } }), '{"a":[3,2,1],"b":1,"c":{"y":true,"z":null}}');
  assert.equal(canon([]), '[]');
  assert.equal(canon({}), '{}');
  assert.equal(canon('x"y\\z\n'), '"x\\"y\\\\z\\n"');
  assert.equal(canon({ 'é': 'é' }), canon({ 'é': 'é' }), 'строки и ключи в NFC');
  assert.equal(canon('é'), '"é"');
  assert.equal(canon(-0), '0');
  assert.equal(canon({ a: undefined, b: 1 }), '{"b":1}', 'undefined в объекте опускается');
  // порядок по кодовым точкам, а не по UTF-16: U+FFFF < U+10000
  assert.equal(canon({ '\u{10000}': 1, '￿': 2 }), '{"￿":2,"\u{10000}":1}');
  assert.equal(canon({ B: 1, a: 2, 'Б': 3, '10': 4, '2': 5 }), '{"10":4,"2":5,"B":1,"a":2,"Б":3}');
  const deep = { y: [{ b: 2, a: 1 }, [{ d: 4, c: 3 }]], x: 'x' };
  assert.equal(canon(deep), '{"x":"x","y":[{"a":1,"b":2},[{"c":3,"d":4}]]}');
  assert.equal(canon(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
});

test('canon: float, NaN, вне safe-integer, BigInt → E_NOT_INTEGER; не-JSON типы → E_SCHEMA', () => {
  for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 53, Number.MAX_SAFE_INTEGER + 2, 1e21, 0.1]) {
    throws_code(() => canon(bad), 'E_NOT_INTEGER', String(bad));
    throws_code(() => canon({ a: [bad] }), 'E_NOT_INTEGER');
  }
  throws_code(() => canon(10n), 'E_NOT_INTEGER');
  throws_code(() => canon(undefined), 'E_SCHEMA');
  throws_code(() => canon([1, undefined]), 'E_SCHEMA');
  throws_code(() => canon(() => 1), 'E_SCHEMA');
  throws_code(() => canon(Symbol('x')), 'E_SCHEMA');
  throws_code(() => canon(new Map()), 'E_SCHEMA');
  throws_code(() => canon(new Set([1])), 'E_SCHEMA');
  throws_code(() => canon(new Date(0)), 'E_SCHEMA');
  throws_code(() => canon({ 'é': 1, 'é': 2 }), 'E_SCHEMA', 'ключи, совпавшие после NFC');
  assert.equal(canon(Number.MAX_SAFE_INTEGER), '9007199254740991');
  assert.equal(canon(-Number.MAX_SAFE_INTEGER), '-9007199254740991');
});

/** Перемешать порядок ключей во всей структуре (детерминированно). */
function shuffle_keys(x, rng) {
  if (Array.isArray(x)) return x.map((v) => shuffle_keys(v, rng));
  if (x !== null && typeof x === 'object') {
    const keys = Object.keys(x);
    for (let i = keys.length - 1; i > 0; i--) { const j = rng.int(0, i); [keys[i], keys[j]] = [keys[j], keys[i]]; }
    const out = {};
    for (const k of keys) out[k] = shuffle_keys(x[k], rng);
    return out;
  }
  return x;
}

// ── TST-33: детерминизм inputs_hash ───────────────────────────────────────────

const WINDOW = () => ({
  events: [{ event_id: 'e1', type: 'anchor.set', v: 1, seq: 1, payload: { account_id: 'acc_main', date: '2026-10-04', amount_minor: 400000 } }],
  rules: [{ rule_id: 'R-RENT', version: 1, amount: { exp_minor: -90000 }, by_monthday: [25] }],
  params: { horizon_days: 57, buffer_minor: 50000, 'worse.income_delay_days': 14 },
  as_of: '2026-10-04',
  engine_version: '0.1.0',
});

test('TST-33 inputs_hash: тот же вход → тот же хэш; порядок ключей и обход не влияют; это sha256(canon(window))', () => {
  const w = WINDOW();
  const h = inputs_hash(w);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(inputs_hash(WINDOW()), h);
  assert.equal(h, node_sha(canon(w)), 'inputs_hash = hex(sha256(canon(window)))');
  const rng = make_rng(33);
  for (let i = 0; i < 100; i++) assert.equal(inputs_hash(shuffle_keys(w, rng)), h);
  assert.equal(inputs_hash(JSON.parse(JSON.stringify(w))), h, 'форма на диске (JSON round-trip) не влияет');
  assert.equal(inputs_hash({ ...w, extra: undefined }), h, 'undefined-ключ не влияет');
});

test('TST-33 inputs_hash: смена as_of, engine_version, версии правила, параметра или записи меняет хэш', () => {
  const h = inputs_hash(WINDOW());
  const changed = [
    { ...WINDOW(), as_of: '2026-10-05' },
    { ...WINDOW(), engine_version: '0.1.1' },
    { ...WINDOW(), rules: [{ ...WINDOW().rules[0], version: 2 }] },
    { ...WINDOW(), params: { ...WINDOW().params, buffer_minor: 50001 } },
    { ...WINDOW(), events: [{ ...WINDOW().events[0], payload: { ...WINDOW().events[0].payload, amount_minor: 400001 } }] },
    { ...WINDOW(), events: [] },
  ];
  const seen = new Set([h]);
  for (const w of changed) { const x = inputs_hash(w); assert.ok(!seen.has(x), 'хэши различаются'); seen.add(x); }
  throws_code(() => inputs_hash({ ...WINDOW(), params: { buffer_minor: 1.5 } }), 'E_NOT_INTEGER');
  throws_code(() => inputs_hash(null), 'E_SCHEMA');
  throws_code(() => inputs_hash([]), 'E_SCHEMA');
  throws_code(() => inputs_hash('x'), 'E_SCHEMA');
});

// ── фабрика журнала G-001 ─────────────────────────────────────────────────────

function journal_factory() {
  let seq = 0;
  const ctx = (extra = {}) => {
    seq += 1;
    return { event_id: `ev-${String(seq).padStart(4, '0')}`, seq, recorded_at: `2026-10-04T08:${String(seq % 60).padStart(2, '0')}:00Z`, actor: 'user', ...extra };
  };
  return { ctx, ev: (type, payload, extra) => make_event(type, payload, ctx(extra)) };
}

function g001_journal() {
  const { ev } = journal_factory();
  const rent = g001_rules()[0];
  return [
    ev('account.opened', { account_id: 'acc_main', name: 'Основной', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' }),
    ev('calendar.set', { calendar_id: 'cal_default', name: 'Стандартный', weekend_dows: [0, 6], holidays: [] }),
    ev('params.set', { horizon_days: 57, buffer_minor: 50000, 'worse.income_delay_days': 14 }, { entity_id: 'ws_1' }),
    ev('anchor.set', { anchor_id: 'anc_main_20261004', account_id: 'acc_main', date: '2026-10-04', amount_minor: 400000 }),
    ev('rule.set', { ...rent, calendar_id: 'cal_default', version: 1 }),
    ev('stream.set', { stream_id: 'S-HOURLY', account_id: 'acc_main', name: 'Почасовая оплата', currency: 'EUR', rate_minor: 3000, period: 'month', pay_lag_days: 5 }),
    ev('taxrule.set', { tax_rule_id: 'TR-20', version: 1, kind: 'percent_of_income', rate_bp: 2000, base: 'gross', valid_from: '2026-01-01', reserve_id: 'RES-TAX' }),
    ev('taxrule.set', { tax_rule_id: 'TR-20', version: 2, kind: 'percent_of_income', rate_bp: 2200, base: 'gross', valid_from: '2026-07-01', reserve_id: 'RES-TAX' }),
    ev('reserve.set', { reserve_id: 'RES-TAX', kind: 'tax', name: 'Налоговый конверт', currency: 'EUR', funded_start_minor: 150000, funded_as_of: '2026-10-04' }),
    ev('plan.set', { plan_id: 'P-TAX1', account_id: 'acc_main', date: '2026-10-23', amount_minor: -50000, currency: 'EUR', is_obligation: true, reserve_id: 'RES-TAX' }),
    ev('tx.posted', { account_id: 'acc_main', date: '2026-10-02', amount_minor: 288000, currency: 'EUR', tag: 'почасовая' }, { entity_id: 'tx_0001' }),
  ];
}

// ── make_event ────────────────────────────────────────────────────────────────

test('make_event: поля, версия, entity_id из payload, копия payload', () => {
  const p = { anchor_id: 'a1', account_id: 'acc_main', date: '2026-10-04', amount_minor: 400000 };
  const e = make_event('anchor.set', p, { event_id: '01a105fc-1910-7e19-a6c7-90d4b25a3c18', seq: 7, recorded_at: '2026-10-04T08:16:10Z', actor: 'user' });
  assert.deepEqual(e, { event_id: '01a105fc-1910-7e19-a6c7-90d4b25a3c18', type: 'anchor.set', v: 1, entity_id: 'a1', payload: p, recorded_at: '2026-10-04T08:16:10Z', seq: 7, actor: 'user' });
  p.amount_minor = 1;
  assert.equal(e.payload.amount_minor, 400000, 'payload скопирован');
  const t = make_event('tx.posted', { a: 1 }, { event_id: 'x', seq: 1, recorded_at: '2026-10-04T08:16:10.123Z', entity_id: 'tx_1', actor: 'import:b1', causation_id: 'c0', supersedes_id: 's0' });
  assert.equal(t.entity_id, 'tx_1'); assert.equal(t.actor, 'import:b1'); assert.equal(t.causation_id, 'c0'); assert.equal(t.supersedes_id, 's0');
  const r = make_event('revert', { target: 'ev-1' }, { event_id: 'r', seq: 2, recorded_at: '2026-10-04T08:16:10Z' });
  assert.equal(r.entity_id, 'ev-1', 'для revert без явной сущности — цель');
  assert.equal(r.actor, 'user', 'актор по умолчанию');
  assert.equal(make_event('revert', { target: 'ev-1' }, { event_id: 'r', seq: 2, recorded_at: '2026-10-04T08:16:10Z', entity_id: 'tx_0001' }).entity_id, 'tx_0001');
  assert.ok(EVENT_TYPES.includes('plan.set') && EVENT_TYPES.includes('match.set') && EVENT_TYPES.includes('debt.set'));
  assert.ok(!EVENT_TYPES.includes('tx.voided'), 'tx.voided удалён (C-070)');
});

test('make_event: отказы (float, неизвестный и удалённый тип, нет seq/id/времени, актор)', () => {
  const ok = { event_id: 'e', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 'x' };
  throws_code(() => make_event('tx.posted', { amount_minor: 19.99 }, ok), 'E_NOT_INTEGER');
  throws_code(() => make_event('tx.posted', { amount_minor: 2 ** 53 }, ok), 'E_NOT_INTEGER');
  throws_code(() => make_event('tx.voided', {}, ok), 'E_SCHEMA');
  throws_code(() => make_event('nope', {}, ok), 'E_SCHEMA');
  throws_code(() => make_event('tx.posted', {}, { ...ok, seq: undefined }), 'E_SCHEMA');
  throws_code(() => make_event('tx.posted', {}, { ...ok, seq: 1.5 }), 'E_SCHEMA');
  throws_code(() => make_event('tx.posted', {}, { ...ok, event_id: '' }), 'E_SCHEMA');
  throws_code(() => make_event('tx.posted', {}, { ...ok, recorded_at: '2026-10-04' }), 'E_SCHEMA');
  throws_code(() => make_event('tx.posted', {}, { ...ok, recorded_at: 'вчера' }), 'E_SCHEMA');
  throws_code(() => make_event('tx.posted', {}, { ...ok, actor: 'robot' }), 'E_SCHEMA');
  throws_code(() => make_event('tx.posted', {}, { ...ok, entity_id: undefined }), 'E_SCHEMA', 'для tx.posted сущность обязательна');
  throws_code(() => make_event('tx.posted', [], ok), 'E_SCHEMA');
  throws_code(() => make_event('tx.posted', {}, null), 'E_SCHEMA');
  for (const actor of ['user', 'system', 'import:b1', 'assistant:d1']) assert.equal(make_event('tx.posted', {}, { ...ok, actor }).actor, actor);
});

// ── effective_events ──────────────────────────────────────────────────────────

test('effective_events: ввод −45,00 €, undo, redo — три записи, ввод снова эффективен (откат отката)', () => {
  const { ev } = journal_factory();
  const tx = ev('tx.posted', { account_id: 'acc_main', date: '2026-10-03', amount_minor: -4500, currency: 'EUR' }, { entity_id: 'tx_1' });
  const undo = ev('revert', { target: tx.event_id }, { entity_id: 'tx_1' });
  const redo = ev('revert', { target: undo.event_id }, { entity_id: 'tx_1' });
  assert.deepEqual(effective_events([tx]).map((e) => e.event_id), [tx.event_id]);
  assert.deepEqual(effective_events([tx, undo]), []);
  assert.deepEqual(effective_events([tx, undo, redo]).map((e) => e.event_id), [tx.event_id], 'revert записи revert возвращает действие');
  const undo2 = ev('revert', { target: redo.event_id }, { entity_id: 'tx_1' });
  assert.deepEqual(effective_events([tx, undo, redo, undo2]), [], 'четвёртая запись снова отменяет');
});

test('effective_events: правка supersedes_id заменяет исходную; откат записи-замены возвращает исходную (C-070)', () => {
  const { ev } = journal_factory();
  const orig = ev('tx.posted', { account_id: 'a', date: '2026-10-03', amount_minor: -4500, currency: 'EUR' }, { entity_id: 'tx_1' });
  const fix = ev('tx.posted', { account_id: 'a', date: '2026-10-03', amount_minor: -4700, currency: 'EUR' }, { entity_id: 'tx_1', supersedes_id: orig.event_id });
  assert.deepEqual(effective_events([orig, fix]).map((e) => e.event_id), [fix.event_id]);
  const undo_fix = ev('revert', { target: fix.event_id }, { entity_id: 'tx_1' });
  assert.deepEqual(effective_events([orig, fix, undo_fix]).map((e) => e.event_id), [orig.event_id], 'откат замены возвращает исходную');
  const redo_fix = ev('revert', { target: undo_fix.event_id }, { entity_id: 'tx_1' });
  assert.deepEqual(effective_events([orig, fix, undo_fix, redo_fix]).map((e) => e.event_id), [fix.event_id]);
  // откат исходной (уже замещённой) записи ничего не меняет, пока замена эффективна
  const undo_orig = ev('revert', { target: orig.event_id }, { entity_id: 'tx_1' });
  assert.deepEqual(effective_events([orig, fix, undo_orig]).map((e) => e.event_id), [fix.event_id]);
  // цепочка правок: orig ← fix1 ← fix2
  const { ev: ev2 } = journal_factory();
  const a = ev2('tx.posted', { x: 1 }, { entity_id: 't' });
  const b = ev2('tx.posted', { x: 2 }, { entity_id: 't', supersedes_id: a.event_id });
  const c = ev2('tx.posted', { x: 3 }, { entity_id: 't', supersedes_id: b.event_id });
  assert.deepEqual(effective_events([a, b, c]).map((e) => e.event_id), [c.event_id], 'цепочка правок: эффективна только последняя (без двойного учёта)');
  const rc = ev2('revert', { target: c.event_id }, { entity_id: 't' });
  assert.deepEqual(effective_events([a, b, c, rc]).map((e) => e.event_id), [b.event_id], 'откат последней правки возвращает предыдущую');
  const rrc = ev2('revert', { target: rc.event_id }, { entity_id: 't' });
  assert.deepEqual(effective_events([a, b, c, rc, rrc]).map((e) => e.event_id), [c.event_id], 'откат отката возвращает последнюю правку');
});

test('effective_events: порядок по seq независимо от порядка входа; ссылки только назад; дубли seq и id — E_SCHEMA', () => {
  const j = g001_journal();
  const shuffled = [...j].reverse();
  assert.deepEqual(effective_events(shuffled).map((e) => e.seq), j.map((e) => e.seq));
  const { ev } = journal_factory();
  const a = ev('tx.posted', { x: 1 }, { entity_id: 't' });
  const bad_revert = ev('revert', { target: 'ev-9999' }, { entity_id: 't' });
  assert.deepEqual(effective_events([a, bad_revert]).map((e) => e.event_id), [a.event_id], 'ссылка на неизвестную запись (срез журнала) игнорируется');
  // ссылка вперёд
  const first = make_event('revert', { target: 'later' }, { event_id: 'early', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  const later = make_event('tx.posted', { x: 1 }, { event_id: 'later', seq: 2, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  throws_code(() => effective_events([first, later]), 'E_SCHEMA');
  const sup_fwd = make_event('tx.posted', { x: 1 }, { event_id: 'e1', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't', supersedes_id: 'e2' });
  const e2 = make_event('tx.posted', { x: 2 }, { event_id: 'e2', seq: 2, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  throws_code(() => effective_events([sup_fwd, e2]), 'E_SCHEMA');
  const self = make_event('revert', { target: 'self' }, { event_id: 'self', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  throws_code(() => effective_events([self]), 'E_SCHEMA');
  const dup_seq = make_event('tx.posted', { x: 1 }, { event_id: 'd2', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  const dup_seq2 = make_event('tx.posted', { x: 1 }, { event_id: 'd1', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  throws_code(() => effective_events([dup_seq, dup_seq2]), 'E_SCHEMA');
  const dup_id = make_event('tx.posted', { x: 1 }, { event_id: 'same', seq: 2, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  const dup_id2 = make_event('tx.posted', { x: 1 }, { event_id: 'same', seq: 3, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  throws_code(() => effective_events([dup_id, dup_id2]), 'E_SCHEMA');
  throws_code(() => effective_events([{ event_id: 'n', type: 'tx.posted', payload: {} }]), 'E_SCHEMA');
  throws_code(() => effective_events([make_event('revert', {}, { event_id: 'r', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' })]), 'E_SCHEMA');
});

test('TST-32 effective_events: идемпотентна и устойчива к повторному вызову; не мутирует вход', () => {
  const j = g001_journal();
  const t = make_event('tx.posted', { a: 1 }, { event_id: 'tx-x', seq: 98, recorded_at: '2026-10-04T08:59:00Z', entity_id: 'tx_x' });
  const rv = make_event('revert', { target: t.event_id }, { event_id: 'rv1', seq: 99, recorded_at: '2026-10-04T09:00:00Z', entity_id: 'tx_x' });
  const full = [...j, t, rv];
  const snapshot = JSON.stringify(full);
  const e1 = effective_events(full);
  assert.equal(JSON.stringify(full), snapshot);
  assert.deepEqual(effective_events(e1), e1, 'эффективные записи эффективны (нет revert-ов внутри)');
  assert.deepEqual(effective_events(full), e1);
});

// ── reduce и состояние ────────────────────────────────────────────────────────

test('reduce: свёртка журнала G-001 — счета, якорь, правило, поток, версии налога, резерв, разовый план, факт, params', () => {
  const s = reduce(effective_events(g001_journal()));
  assert.equal(s.accounts.acc_main.currency, 'EUR');
  assert.equal(s.anchors.anc_main_20261004.amount_minor, 400000);
  assert.equal(s.rules['R-RENT'].amount.exp_minor, -90000);
  assert.equal(s.rules['R-RENT'].calendar_id, 'cal_default');
  assert.equal(s.streams['S-HOURLY'].rate_minor, 3000);
  assert.deepEqual(s.tax_rules['TR-20'].map((v) => [v.version, v.rate_bp]), [[1, 2000], [2, 2200]], 'все версии налогового правила');
  assert.equal(s.reserves['RES-TAX'].funded_start_minor, 150000);
  assert.equal(s.plans['P-TAX1'].amount_minor, -50000);
  assert.equal(s.facts.tx_0001.amount_minor, 288000);
  assert.equal(s.facts.tx_0001.entity_id, 'tx_0001');
  assert.equal(s.params.buffer_minor, 50000);
  assert.equal(s.params['worse.income_delay_days'], 14);
  assert.deepEqual(s.calendars.cal_default.weekend_dows, [0, 6]);
  assert.deepEqual(Object.keys(empty_state()).sort(), Object.keys(s).sort(), 'форма состояния стабильна');
});

test('reduce: отменённые и замещённые записи в состояние не попадают; рядом с откатом — исходное значение', () => {
  const { ev } = journal_factory();
  const a1 = ev('account.opened', { account_id: 'acc_x', name: 'X', currency: 'EUR', exponent: 2, kind: 'bank', liquidity: 'operating' });
  const r1 = ev('rule.set', { rule_id: 'R-A', version: 1, amount: { exp_minor: -100 } });
  const r2 = ev('rule.set', { rule_id: 'R-A', version: 2, amount: { exp_minor: -200 } }, { supersedes_id: r1.event_id });
  const rv = ev('revert', { target: r2.event_id }, { entity_id: 'R-A' });
  const s_before = reduce(effective_events([a1, r1, r2]));
  const s_after = reduce(effective_events([a1, r1, r2, rv]));
  assert.equal(s_before.rules['R-A'].version, 2);
  assert.equal(s_after.rules['R-A'].version, 1, 'откат правки возвращает версию 1');
});

test('reduce: allocation.recorded идемпотентна по id; wave_override.set хранится в порядке seq; params.set сливается; override.set по ключу', () => {
  const { ev } = journal_factory();
  const al = { allocation_id: 'tax:R-X@ev-1', reserve_id: 'RES-TAX', date: '2026-10-02', amount_minor: 57600, source: 'income', rule_version: 1 };
  const evs = [
    ev('allocation.recorded', al), ev('allocation.recorded', al),
    ev('wave_override.set', { override_id: 'w1', action: 'split', event_ids: ['a'] }),
    ev('wave_override.set', { override_id: 'w2', action: 'merge', event_ids: ['a', 'b'] }),
    ev('params.set', { buffer_minor: 1 }, { entity_id: 'ws' }), ev('params.set', { buffer_minor: null, horizon_days: 57 }, { entity_id: 'ws' }),
    ev('override.set', { rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'move', date: '2026-11-27' }),
    ev('override.set', { rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'skip' }),
  ];
  const s = reduce(effective_events(evs));
  assert.equal(Object.keys(s.allocations).length, 1);
  assert.deepEqual(s.wave_overrides.map((w) => [w.override_id, w.seq]), [['w1', 3], ['w2', 4]]);
  assert.deepEqual(s.params, { buffer_minor: null, horizon_days: 57 });
  assert.equal(s.overrides['R-RENT@2026-11-25'].action, 'skip', 'при повторе ключа побеждает последний');
});

test('reduce: match.set проставляет plan_ref и no_plan в проекции факта (факт-запись не мутирует, C-051)', () => {
  const { ev } = journal_factory();
  const tx1 = ev('tx.posted', { account_id: 'a', date: '2026-10-26', amount_minor: -90000, currency: 'EUR' }, { entity_id: 'tx_1' });
  const tx2 = ev('tx.posted', { account_id: 'a', date: '2026-10-27', amount_minor: -500, currency: 'EUR' }, { entity_id: 'tx_2' });
  const m1 = ev('match.set', { fact_event_id: tx1.event_id, plan_ref: 'R-RENT@2026-10-25' }, { entity_id: tx1.event_id });
  const m2 = ev('match.set', { fact_event_id: 'tx_2', no_plan: true }, { entity_id: 'tx_2' });
  const raw = JSON.stringify(tx1);
  const s = reduce(effective_events([tx1, tx2, m1, m2]));
  assert.equal(s.facts.tx_1.plan_ref, 'R-RENT@2026-10-25');
  assert.equal(s.facts.tx_2.no_plan, true);
  assert.equal(s.facts.tx_1.no_plan, undefined);
  assert.equal(JSON.stringify(tx1), raw, 'исходная запись журнала не изменилась');
  // повторная привязка заменяет прежнюю; откат привязки снимает её
  const m3 = ev('match.set', { fact_event_id: tx1.event_id, no_plan: true }, { entity_id: tx1.event_id });
  const s3 = reduce(effective_events([tx1, tx2, m1, m2, m3]));
  assert.equal(s3.facts.tx_1.plan_ref, undefined); assert.equal(s3.facts.tx_1.no_plan, true);
  const rv = ev('revert', { target: m1.event_id }, { entity_id: tx1.event_id });
  const s4 = reduce(effective_events([tx1, tx2, m1, m2, rv]));
  assert.equal(s4.facts.tx_1.plan_ref, undefined);
});

test('reduce: account.closed, import.started / rolled_back, v2-типы без интерпретации', () => {
  const { ev } = journal_factory();
  const evs = [
    ev('account.opened', { account_id: 'a', name: 'A', currency: 'EUR' }),
    ev('account.closed', { account_id: 'a', closed_on: '2026-12-31' }),
    ev('import.started', { batch_id: 'b1', profile_id: 'p', source_hash: 'h', counts: { recognized: 3, rejected: 0, duplicates: 0 } }),
    ev('import.rolled_back', { batch_id: 'b1' }),
    ev('consent.granted', { scope: 'assistant_cloud', version: 1 }, { entity_id: 'c1' }),
  ];
  const s = reduce(effective_events(evs));
  assert.equal(s.accounts.a.closed_on, '2026-12-31');
  assert.equal(s.imports.b1.rolled_back, true);
  assert.equal(s.imports.b1.counts.recognized, 3);
  assert.equal(s.extra['consent.granted'].c1.scope, 'assistant_cloud');
  throws_code(() => reduce(effective_events([ev('account.closed', { account_id: 'ghost', closed_on: '2026-12-31' })])), 'E_SCHEMA');
});

test('reduce: отказы — revert, float и неизвестный тип в сырой записи; base не мутируется; reduce(events, base) = свёртка префикса + хвоста', () => {
  const { ev } = journal_factory();
  const rv = make_event('revert', { target: 'x' }, { event_id: 'r', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 'e' });
  throws_code(() => reduce([rv]), 'E_SCHEMA');
  const raw_float = { event_id: 'f', type: 'tx.posted', v: 1, entity_id: 't', payload: { amount_minor: 1.5 }, recorded_at: '2026-10-04T08:00:00Z', seq: 1, actor: 'user' };
  throws_code(() => reduce([raw_float]), 'E_NOT_INTEGER');
  throws_code(() => reduce([{ ...raw_float, payload: { amount_minor: 1 }, type: 'nope.set' }]), 'E_SCHEMA');
  throws_code(() => reduce([{ ...raw_float, payload: { amount_minor: 1 }, v: undefined }]), 'E_SCHEMA');
  throws_code(() => reduce([ev('rule.set', { amount: { exp_minor: -1 } })]), 'E_SCHEMA', 'нет rule_id');
  const j = g001_journal();
  const full = reduce(effective_events(j));
  const head = reduce(effective_events(j.slice(0, 5)));
  const head_copy = JSON.stringify(head);
  const merged = reduce(effective_events(j).slice(5), head);
  assert.equal(JSON.stringify(head), head_copy, 'base не изменён');
  assert.equal(state_hash(merged), state_hash(full), 'fold(все) = fold(снимок, хвост)');
});

test('TST-38 state_hash: sha256(canon(state)); не зависит от порядка входа, порядка ключей, recorded_at, формы JSON на диске', () => {
  const j = g001_journal();
  const s = reduce(effective_events(j));
  const h = state_hash(s);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, node_sha(canon(s)));
  const rng = make_rng(38);
  assert.equal(state_hash(reduce(effective_events([...j].reverse()))), h, 'порядок записей на входе не важен (по seq)');
  const disk = JSON.parse(JSON.stringify(j));
  assert.equal(state_hash(reduce(effective_events(disk))), h, 'round-trip через JSON');
  for (let i = 0; i < 20; i++) assert.equal(state_hash(reduce(effective_events(j.map((e) => shuffle_keys(e, rng))))), h, 'порядок ключей на диске не влияет');
  const later = j.map((e) => ({ ...e, recorded_at: '2027-01-01T00:00:00Z' }));
  assert.equal(state_hash(reduce(effective_events(later))), h, 'recorded_at в состояние не входит (C-071)');
  const edited = reduce(effective_events([...j.slice(0, 3), make_event('anchor.set', { anchor_id: 'a2', account_id: 'acc_main', date: '2026-10-05', amount_minor: 1 }, { event_id: 'zz', seq: 500, recorded_at: '2026-10-04T10:00:00Z' })]));
  assert.notEqual(state_hash(edited), h);
});

// ── upcast ────────────────────────────────────────────────────────────────────

test('upcast: v обязательна; запись текущей версии без изменений; более новая v — E_SCHEMA (только чтение); апкастеры v → v+1', () => {
  const e = make_event('tx.posted', { account_id: 'a', amount_minor: 1 }, { event_id: 'u', seq: 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 't' });
  assert.equal(upcast(e), e);
  const no_v = { ...e }; delete no_v.v;
  throws_code(() => upcast(no_v), 'E_SCHEMA');
  throws_code(() => upcast({ ...e, v: 0 }), 'E_SCHEMA');
  throws_code(() => upcast({ ...e, v: 2 }), 'E_SCHEMA', 'неизвестная более новая версия');
  throws_code(() => upcast({ ...e, type: 'nope' }), 'E_SCHEMA');
  throws_code(() => upcast(null), 'E_SCHEMA');
  // иллюстрация из product/04: в v1 сумма была дробью 19.99 строкой; апкастер превращает её в minor
  const registry = {
    current: { ...DEFAULT_UPCAST_REGISTRY.current, 'tx.posted': 2 },
    steps: {
      'tx.posted': {
        1: (x) => ({ ...x, v: 2, payload: { ...x.payload, amount_minor: parse_minor(String(x.payload.amount), { decimal: '.', thousands: '', exponent: 2 }) } }),
      },
    },
  };
  const old = { event_id: 'o', type: 'tx.posted', v: 1, entity_id: 't', payload: { account_id: 'a', amount: '19.99' }, recorded_at: '2026-10-04T08:00:00Z', seq: 1, actor: 'user' };
  const raw = JSON.stringify(old);
  const up = upcast(old, registry);
  assert.equal(up.v, 2);
  assert.equal(up.payload.amount_minor, 1999);
  assert.equal(JSON.stringify(old), raw, 'запись на диске не меняется');
  const s = reduce([old], undefined);
  assert.equal(s.facts.t.amount, '19.99', 'с реестром по умолчанию (v=1 текущая) запись принимается как есть');
  // цепочка двух шагов и ошибки апкастеров
  const chain = { current: { ...DEFAULT_UPCAST_REGISTRY.current, 'tx.posted': 3 }, steps: { 'tx.posted': { 1: (x) => ({ ...x, v: 2 }), 2: (x) => ({ ...x, v: 3, payload: { ...x.payload, migrated: true } }) } } };
  const u3 = upcast(old, chain);
  assert.equal(u3.v, 3); assert.equal(u3.payload.migrated, true);
  const bad_step = { current: { ...DEFAULT_UPCAST_REGISTRY.current, 'tx.posted': 3 }, steps: { 'tx.posted': { 1: (x) => ({ ...x, v: 3 }) } } };
  throws_code(() => upcast(old, bad_step), 'E_SCHEMA');
  const missing = { current: { ...DEFAULT_UPCAST_REGISTRY.current, 'tx.posted': 2 }, steps: {} };
  throws_code(() => upcast(old, missing), 'E_SCHEMA');
});

// ── norm, dedup_key (TST-42), state_at ────────────────────────────────────────

test('TST-42 norm и dedup_key: векторы §9.13 (f78f01e9751c5f66; Cafe Central k=0 / k=1)', () => {
  assert.equal(norm('MERCADONA  *1234 Valencia, ES'), 'mercadona 1234 valencia es');
  assert.equal(norm('  Café—Ñandú!!  '), 'café ñandú');
  assert.equal(norm('ＡＢＣ　１２３'), 'abc 123', 'NFKC: полноширинные символы');
  assert.equal(norm('***'), '');
  assert.equal(norm('Привет, МИР'), 'привет мир');
  assert.equal(dedup_key('acc_bank', '2026-10-03', -4730, 'EUR', 'MERCADONA  *1234 Valencia, ES', 0), 'f78f01e9751c5f66');
  assert.equal(dedup_key('acc_bank', '2026-10-03', -450, 'EUR', 'Cafe Central', 0), '9d82db80ee854a7c');
  assert.equal(dedup_key('acc_bank', '2026-10-03', -450, 'EUR', 'Cafe Central', 1), 'b9f6b8bb563b3b40');
  assert.equal(dedup_key('acc_bank', '2026-10-03', -450, 'EUR', 'cafe   central!!', 0), '9d82db80ee854a7c', 'описание нормализуется');
  // прообраз = acc|date|amount|currency|norm(desc)|k
  assert.equal(dedup_key('acc_bank', '2026-10-03', -4730, 'EUR', 'MERCADONA  *1234 Valencia, ES', 0),
    node_sha('acc_bank|2026-10-03|-4730|EUR|mercadona 1234 valencia es|0').slice(0, 16));
  assert.equal(dedup_key('acc_bank', parse_date('2026-10-03'), -4730, 'EUR', 'MERCADONA  *1234 Valencia, ES', 0), 'f78f01e9751c5f66', 'дата как EpochDay');
  assert.match(dedup_key('a', '2026-01-01', 0, 'EUR', '', 0), /^[0-9a-f]{16}$/);
  assert.notEqual(dedup_key('acc_bank', '2026-10-03', -4730, 'EUR', 'x', 0), dedup_key('acc_bank', '2026-10-03', -4731, 'EUR', 'x', 0));
  throws_code(() => dedup_key('a', '2026-10-03', -1.5, 'EUR', 'x', 0), 'E_NOT_INTEGER');
  throws_code(() => dedup_key('a', '2026-10-03', -1, 'EUR', 'x', -1), 'E_SCHEMA');
  throws_code(() => dedup_key('a', '2026-10-03', -1, 'EUR', 'x', 0.5), 'E_SCHEMA');
  throws_code(() => dedup_key('a', '03.10.2026', -1, 'EUR', 'x', 0), 'E_BAD_DATE');
  throws_code(() => dedup_key('a', 1.5, -1, 'EUR', 'x', 0), 'E_BAD_DATE');
});

test('dedup_key: локальное преобразование EpochDay → ISO совпадает с dates.format_date на всех днях 1970–2100', () => {
  for (let z = 0; z <= 47846; z += 7) {
    assert.equal(dedup_key('a', z, 1, 'EUR', 'x', 0), dedup_key('a', format_date(z), 1, 'EUR', 'x', 0), `z = ${z}`);
  }
  for (const z of [0, 47846, 20730, 21243, -1, 719162 * -1 + 1]) {
    assert.equal(dedup_key('a', z, 1, 'EUR', 'x', 0), dedup_key('a', format_date(z), 1, 'EUR', 'x', 0), `z = ${z}`);
  }
});

test('state_at: срез по recorded_at — введённое задним числом невидимо; день включительно; ISO или EpochDay', () => {
  const mk = (id, seq, day) => make_event('tx.posted', { n: seq }, { event_id: id, seq, recorded_at: `${day}T12:00:00Z`, entity_id: id });
  const j = [mk('a', 1, '2026-10-01'), mk('b', 2, '2026-10-03'), mk('c', 3, '2026-10-03'), mk('d', 4, '2026-10-05')];
  assert.deepEqual(state_at(j, '2026-10-02').map((e) => e.event_id), ['a']);
  assert.deepEqual(state_at(j, '2026-10-03').map((e) => e.event_id), ['a', 'b', 'c'], 'день включительно');
  assert.deepEqual(state_at(j, parse_date('2026-10-03')).map((e) => e.event_id), ['a', 'b', 'c']);
  assert.deepEqual(state_at(j, '2026-09-30'), []);
  assert.deepEqual(state_at(j, '2099-01-01').map((e) => e.event_id), ['a', 'b', 'c', 'd']);
  // монотонность: state_at(t) ⊆ state_at(t')
  const days = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
  for (let i = 1; i < days.length; i++) {
    const lo = new Set(state_at(j, days[i - 1]).map((e) => e.event_id));
    for (const e of state_at(j, days[i])) lo.delete(e.event_id);
    assert.equal(lo.size, 0);
  }
  // запись откатом, введённая позже среза, срезом отсекается — «как знали тогда»
  const rv = make_event('revert', { target: 'a' }, { event_id: 'r', seq: 5, recorded_at: '2026-10-06T08:00:00Z', entity_id: 'a' });
  const at_oct4 = effective_events(state_at([...j, rv], '2026-10-04'));
  assert.ok(at_oct4.some((e) => e.event_id === 'a'), 'на 10-04 откат ещё не введён');
  assert.ok(!effective_events([...j, rv]).some((e) => e.event_id === 'a'));
  throws_code(() => state_at([{ event_id: 'x', recorded_at: 'вчера' }], '2026-10-04'), 'E_SCHEMA');
  throws_code(() => state_at(j, '04.10.2026'), 'E_BAD_DATE');
});
