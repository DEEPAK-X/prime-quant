---
name: quant
description: Quant research skills for FX/CFD strategy work. Parse trader prompts into deterministic strategy specs, run in-memory backtests that return only a compact JSON summary card (never raw frames), validate against the anti-overfit gate, and record failure patterns into harness memory so future cycles do not repeat them. Use for strategy ideation, backtesting, validation, and iterative refinement.
---

# Quant Skills Bundle

Three cooperating skills wrapped around `primequant` (the deterministic FX/CFD
backtest & validation engine), exposed to the kernel as `rlm.quant`:

- `idea_to_spec` — trader prompt -> validated `StrategySpec`
- `run_backtest` / `validate` — in-memory execution with context compression
- `refine_log_failure` — durable failure-pattern memory for the `/refine` loop

## Context compression rule

Backtest runs return **only** a compact JSON summary card (default budget 150
tokens). Raw DataFrames, equity curves, and trade lists stay bound to the
persistent kernel scope as `_last_backtest_df`, `_last_equity_curve`,
`_last_trades`, `_last_result`, and `_last_card` — inspect them from the kernel
or hand them to subagents, but never paste them into the model context.

## API

Call directly from the kernel:

```python
# 1. Turn a trader prompt into a deterministic spec (surfaces assumptions).
spec = await rlm.quant.idea_to_spec(
    "EURUSD M5 momentum, SMA 10/30 cross, ATR 2 stop, 3 ATR take profit, 1 lot"
)

# 2. Run the in-memory backtest. Uses the kernel-scope `df` when data is omitted.
card = await rlm.quant.run_backtest(spec)          # spec dict
card = await rlm.quant.run_backtest("EURUSD M5 sma cross")  # or raw prompt
card = await rlm.quant.run_backtest(spec, data=df) # explicit OHLCV frame

# 3. Validation gate card (CPCV / walk-forward / DSR / PBO when the engine ships).
gate = await rlm.quant.validate()

# 4. Persist a failure pattern into harness memory so the next cycle avoids it.
record = await rlm.quant.refine_log_failure(
    {"kind": "validation_gate", "pattern": "PBO 0.41 exceeds the 0.25 overfit gate"}
)
```

`await rlm.quant.assumptions(spec)` prints the explicit assumptions behind a
spec before any code executes.

## Safety

- Never dump `_last_backtest_df`, `_last_equity_curve`, or `_last_trades` into
  the model context — keep them bound in the kernel and reference them by name.
- `primequant` (with `polars`/`numpy`) must be installed in the kernel
  environment. When it is missing, run_backtest returns an error card instead
  of raising.
- `refine_log_failure` is idempotent per pattern: re-logging the same failure
  bumps the harness entry version instead of creating a duplicate.
