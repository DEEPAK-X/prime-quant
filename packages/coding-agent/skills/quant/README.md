# Quant Skills Bundle (`rlm.quant`)

The `quant` skill bundle provides programmatic quantitative research and backtesting capabilities for FX/CFD strategies within the persistent Python IPython kernel, integrated with the `primequant` validation engine.

---

## Core Skills

- `rlm.quant.idea_to_spec(prompt)`: Parses natural language trader prompts into validated, deterministic strategy specifications.
- `rlm.quant.fetch_data(symbol, timeframe="M5", bars=5000)`: Pulls live OHLCV bars from MetaTrader 5 into kernel scope (`df` / `_last_df`).
- `rlm.quant.load_data(path, timeframe="M5")`: Ingests broker CSV or Parquet files from disk into canonical OHLCV format.
- `rlm.quant.run_backtest(spec, data=None)`: Runs in-memory backtest and CPCV/walk-forward validation gate, returning a compact JSON card (<150 tokens).
- `rlm.quant.run_pipeline(...)`: Full workflow: AST lint -> backtest -> validation gate -> conditional Optuna optimization -> HTML tearsheet.
- `rlm.quant.refine_log_failure(record)`: Durable failure memory for recording overfit and risk limit breaches.
- `rlm.quant.recall_failures(kind=None)`: Recalls past failure patterns to prevent repeating known dead-ends.

---

## Watchers

The skill bundle provides three schedule-able watcher presets for continuous, automated monitoring via `prime-agent schedule`:

### 1. Risk Watcher
- **Doc**: [`watchers/risk-watcher.md`](watchers/risk-watcher.md)
- **Schedule**: `prime-agent schedule "*/15 * * * *" "<prompt>"`
- **Function**: Periodically monitors active portfolio drawdown and daily loss against `PRIME_QUANT_MAX_DRAWDOWN` and `PRIME_QUANT_MAX_DAILY_LOSS_USD`, calling `rlm.quant.refine_log_failure` on breach.

### 2. Flow Watcher
- **Doc**: [`watchers/flow-watcher.md`](watchers/flow-watcher.md)
- **Schedule**: `prime-agent schedule "*/5 * * * *" "<prompt>"`
- **Function**: Scans a configurable watchlist (`PRIME_QUANT_WATCH_SYMBOLS`) via `rlm.quant.fetch_data`, detecting rolling volume surges (z-scores) and volatility anomalies.

### 3. Research Watcher
- **Doc**: [`watchers/research-watcher.md`](watchers/research-watcher.md)
- **Schedule**: `prime-agent schedule "0 */4 * * *" "<prompt>"`
- **Function**: Automatically triages queued strategy ideas (`PRIME_QUANT_IDEA_QUEUE`), verifies past failure patterns via `rlm.quant.recall_failures`, runs backtests through the anti-overfit validation gate via `rlm.quant.run_backtest`, logs failures, and returns top candidates.
