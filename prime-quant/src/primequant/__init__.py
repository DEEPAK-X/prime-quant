"""prime-quant: deterministic FX/CFD backtest & validation engine.

Polars-first ingestion, vectorized execution modeling variable FX spreads,
slippage, and per-lot/per-side commission, plus anti-overfit metrics. Returns
compact JSON summaries only - no raw DataFrame context pollution.
"""

from __future__ import annotations

__version__ = "0.1.0"
