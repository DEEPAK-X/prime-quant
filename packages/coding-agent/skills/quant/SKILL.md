---
name: quant
description: Quant research skills for FX/CFD strategy work. Parse trader prompts into deterministic strategy specs, run in-memory backtests that return only a compact JSON summary card (never raw frames), validate against the anti-overfit gate, and record failure patterns into harness memory so future cycles do not repeat them. Use for strategy ideation, backtesting, validation, and iterative refinement.
---

# Quant Skills Bundle

Four cooperating skills wrapped around `primequant` (the deterministic FX/CFD
backtest & validation engine), exposed to the kernel as `rlm.quant`:

- `idea_to_spec` — trader prompt -> validated `StrategySpec`
- `run_backtest` / `validate` — in-memory execution with context compression
- `run_pipeline` — AST lint -> backtest -> validation gate -> conditional
  Optuna optimization -> HTML tearsheet on disk
- `refine_log_failure` — durable failure-pattern memory for the `/refine` loop

## Context compression rule

Backtest runs return **only** a compact JSON summary card (default budget 150
tokens). Raw DataFrames, equity curves, trade lists, the strategy object, and
full HTML tearsheets stay bound to the persistent kernel scope / disk as
`_last_df`, `_last_backtest_df`, `_last_equity_curve`, `_last_trades`,
`_last_result`, `_last_strategy`, and `_last_card` — inspect them from the
kernel or hand them to subagents, but never paste them into the model context.
Tearsheets are written to disk; the card carries only `{report_path,
file_size_kb}`.

## API

Call directly from the kernel:

```python
# 1. Turn a trader prompt into a deterministic spec (surfaces assumptions).
spec = await rlm.quant.idea_to_spec(
    "EURUSD M5 momentum, SMA 10/30 cross, ATR 2 stop, 3 ATR take profit, 1 lot"
)

# 2. Run the in-memory backtest. Uses the kernel-scope `df` when data is omitted.
#    The card includes the real CPCV / walk-forward validation gate (DSR / PBO).
card = await rlm.quant.run_backtest(spec)          # spec dict
card = await rlm.quant.run_backtest("EURUSD M5 sma cross")  # or raw prompt
card = await rlm.quant.run_backtest(spec, data=df) # explicit OHLCV frame

# 3. Validation gate card on the most recent run.
gate = await rlm.quant.validate()

# 4. Full pipeline: AST lint -> backtest -> validation gate -> conditional
#    Optuna optimization (only if the gate passes) -> HTML tearsheet on disk.
#    param_space maps onto the spec's entry rules (fast/slow for sma_cross,
#    period for breakout/rsi_zone). Returns {report_path, file_size_kb} only.
pipe = await rlm.quant.run_pipeline(
    "EURUSD M5 sma cross",
    data=df,
    param_space={"fast": [5, 20], "slow": [20, 60]},
    report_path="tearsheet_EURUSD_M5.html",
)

# 5. Persist a failure pattern into harness memory so the next cycle avoids it.
record = await rlm.quant.refine_log_failure(
    {"kind": "validation_gate", "pattern": "PBO 0.41 exceeds the 0.25 overfit gate"}
)
```

`await rlm.quant.assumptions(spec)` prints the explicit assumptions behind a
spec before any code executes.

## Safety

- Never dump `_last_df`, `_last_backtest_df`, `_last_equity_curve`, or
  `_last_trades` into the model context — keep them bound in the kernel and
  reference them by name. The tearsheet HTML lives on disk only.
- `primequant` (with `polars`/`numpy`, and `optuna` for optimization) must be
  installed in the kernel environment. When it is missing, run_backtest
  returns an error card instead of raising. `run_pipeline` with a
  `param_space` requires `optuna`.
- The AST lint gate (`primequant.validate.ast_linter`) blocks strategy
  execution on lookahead/leakage patterns and returns a `status: "blocked"`
  card with the first offending issue.
- Optimization never runs unless the validation gate passed; a failed gate
  yields `"optimization": {"skipped": true}` while the tearsheet still
  records the FAIL state with full failure reasons on disk.
- `refine_log_failure` is idempotent per pattern: re-logging the same failure
  bumps the harness entry version instead of creating a duplicate.
