// vocab.generated.mjs — ГЕНЕРИРУЕТСЯ tools/gen_vocab.mjs из engine/vocab.json (FP-17, REQ-019). Руками не править: npm run gen:vocab.
// Значения параметров по умолчанию — данные словаря; модули движка и интерфейс читают их отсюда, а не из литералов в коде.
// Актуальность файла проверяет tests/vocab_generated.test.mjs (и `npm run gen:vocab:check`). Модуль чистый: данные без вычислений и импортов.

export const VOCAB_FORMAT = "runway-vocab/1";

/** Параметры рабочей области: `ключ → { default, hypothesis?, phase?, note? }` (порядок — как в vocab.json). */
export const VOCAB_PARAMS = Object.freeze({
  "decision_currency": Object.freeze({ default: null, note: "валюта первого operating-счёта; задаётся при создании рабочей области" }),
  "horizon_days": Object.freeze({ default: 180 }),
  "buffer_minor": Object.freeze({ default: null, note: "не задан (null): Q1 и волны считают B = 0 с W_BUFFER_UNSET; Q3 и «можно потратить» не отвечают (no_buffer); явный 0 — «задан» (C-018)" }),
  "buffer_hint_days": Object.freeze({ default: 7 }),
  "headline_mode": Object.freeze({ default: "worse" }),
  "worse.income_delay_days": Object.freeze({ default: 14, hypothesis: true }),
  "grace_days.income": Object.freeze({ default: 3 }),
  "grace_days.expense": Object.freeze({ default: 0 }),
  "match.window_days": Object.freeze({ default: 3, hypothesis: true }),
  "match.tol_bp": Object.freeze({ default: 500, hypothesis: true }),
  "wave.gap_days": Object.freeze({ default: 3, hypothesis: true }),
  "wave.max_span_days": Object.freeze({ default: 10, hypothesis: true }),
  "wave.threshold_minor": Object.freeze({ default: null, note: "при создании рабочей области: max(30·10^exponent, round_div(Σ исходящих posted за 90 дн., 300)); нет истории — 30·10^exponent (C-022, X1)" }),
  "explain.top_k": Object.freeze({ default: 10 }),
  "explain.share_cutoff_bp": Object.freeze({ default: 9000 }),
  "stale.banner_days": Object.freeze({ default: 7 }),
  "stale.block_days": Object.freeze({ default: 21 }),
  "rounding": Object.freeze({ default: "half_even" }),
  "ready.q1": Object.freeze({ default: 3 }),
  "ready.q3": Object.freeze({ default: 4 }),
  "crypto.liquidity_bp": Object.freeze({ default: 0 }),
  "backup.remind_events": Object.freeze({ default: 50, hypothesis: true }),
  "backup.remind_days": Object.freeze({ default: 7, hypothesis: true }),
  "fx.stale_days": Object.freeze({ default: 30, hypothesis: true }),
  "backtest.h_days": Object.freeze({ default: 30, hypothesis: true }),
  "backtest.min_window_days": Object.freeze({ default: 14, hypothesis: true }),
  "debt.drift_tol_bp": Object.freeze({ default: 50, hypothesis: true, phase: "v2" }),
  "kdf.iterations": Object.freeze({ default: null, note: "определяет ADR до v2" }),
  "kdf.wrap": Object.freeze({ default: null, note: "определяет ADR до v2" }),
  "calib.window": Object.freeze({ default: 24, hypothesis: true, note: "N5" }),
  "calib.prior": Object.freeze({ default: 7, hypothesis: true, note: "N5" }),
  "calib.k": Object.freeze({ default: 3, hypothesis: true, note: "N5" }),
  "calib.alpha_bp": Object.freeze({ default: 3000, hypothesis: true, note: "N5" }),
  "calib.min_origins": Object.freeze({ default: 3, hypothesis: true, note: "N5" }),
  "mc.n_paths": Object.freeze({ default: 2000, hypothesis: true, note: "N5" }),
  "tools.max_calls": Object.freeze({ default: 12, hypothesis: true, note: "N5" }),
});
