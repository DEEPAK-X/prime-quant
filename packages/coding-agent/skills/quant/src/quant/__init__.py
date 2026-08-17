"""Agent Quant Skill Bundle.

Three cooperating skills wrapped around ``primequant`` (the deterministic
FX/CFD backtest & validation engine), exposed to the IPython kernel as
``rlm.quant``:

- ``idea_to_spec`` — trader prompt -> validated StrategySpec, assumptions surfaced
- ``fetch_data`` — live MT5 OHLCV pull bound to kernel ``df`` / ``_last_df``
- ``run_backtest`` / ``validate`` — in-memory execution returning ONLY a compact
  JSON summary card (<= 150 tokens); raw frames stay bound to the kernel scope
  as ``_last_df`` / ``_last_backtest_df`` / ``_last_equity_curve`` / ``_last_trades``
- ``run_pipeline`` — full workflow: AST lint -> backtest -> CPCV + walk-forward
  validation gate -> conditional Optuna optimization -> HTML tearsheet on disk
- ``refine_log_failure`` — durable failure-pattern memory for the /refine loop
- ``recall_failures`` — read counterpart called before generation; returns the
  previously-logged failure patterns so the next strategy idea avoids known
  dead-ends, closing the fail-and-refine loop

All heavy imports (``primequant``, ``polars``, ``numpy``) are lazy so this
package imports in any venv; when the engine is missing, ``run_backtest``
returns an error card with an install hint instead of raising.
"""

from __future__ import annotations

from typing import Any

from .data import DEFAULT_BARS, fetch_data
from .idea_to_spec import (
    ASSET_CLASS_CFD,
    ASSET_CLASS_FOREX,
    UNITS_PER_LOT,
    assumptions,
    idea_to_spec,
    normalize_spec,
)
from .refine import refine_log_failure, recall_failures
from .runner import (
    MAX_CARD_TOKENS,
    CardTooLargeError,
    QuantInputError,
    QuantUnavailableError,
    card_to_json,
    run_backtest,
    run_pipeline,
    run_validation_gate,
    validate,
)

__all__ = [
    "ASSET_CLASS_CFD",
    "ASSET_CLASS_FOREX",
    "DEFAULT_BARS",
    "MAX_CARD_TOKENS",
    "UNITS_PER_LOT",
    "CardTooLargeError",
    "QuantInputError",
    "QuantUnavailableError",
    "assumptions",
    "card_to_json",
    "fetch_data",
    "idea_to_spec",
    "normalize_spec",
    "recall_failures",
    "refine_log_failure",
    "run_backtest",
    "run_pipeline",
    "run_validation_gate",
    "validate",
]


async def run(
    spec: dict[str, Any] | str,
    data: Any = None,
    *,
    validate: bool = True,
    namespace: dict[str, Any] | None = None,
) -> str:
    """Default skill entry point: parse a prompt/spec and run the backtest card.

    ``await quant("EURUSD M5 sma cross")`` is equivalent to
    ``await quant.run_backtest("EURUSD M5 sma cross")``.
    """
    return await run_backtest(spec, data, validate=validate, namespace=namespace)
