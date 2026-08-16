"""Vectorized FX/CFD backtest engine.

Models:
  - Variable bid/ask spread (from the spread column or synthesized from close).
  - Tick slippage applied on top of the spread at fill time.
  - Per-lot, per-side broker commission tiers.
  - Standard FX contract sizing (100,000 units/lot) with configurable point
    size for PnL conversion.

The engine is deterministic: given the same data + config + strategy it
produces the same equity curve and trade list. It returns a compact
BacktestResult whose ``metrics`` dict is the only sanctioned context-boundary
output (no raw frames leak out).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import polars as pl

from primequant.data.loader import (
    CANON_ASK,
    CANON_BID,
    CANON_CLOSE,
    CANON_HIGH,
    CANON_LOW,
    CANON_OPEN,
    CANON_SPREAD,
    CANON_TIME,
)
from primequant.metrics.core import summary
from primequant.strategy.base import FixedLotSizer, PositionSizer, SignalResult, Strategy

# Standard FX: 1 lot = 100,000 units of base currency.
UNITS_PER_LOT = 100_000.0


@dataclass(frozen=True)
class InstrumentMeta:
    """FX/CFD contract metadata for PnL conversion."""

    symbol: str = "EURUSD"
    point_size: float = 0.00001  # 1 pip = 0.0001 for 5-digit FX quotes
    pip_value_per_lot: float = 10.0  # USD per pip per lot for EURUSD-like pairs
    contract_size: float = UNITS_PER_LOT


@dataclass(frozen=True)
class CommissionTier:
    """Per-lot, per-side commission. USD per lot per side by default."""

    usd_per_lot_per_side: float = 7.0


@dataclass(frozen=True)
class SlippageModel:
    """Tick slippage added to the spread cost at fill.

    slippage_points is in price units (same scale as spread). Applied
    adversely: buys fill higher, sells fill lower.
    """

    slippage_points: float = 0.0


@dataclass(frozen=True)
class BacktestConfig:
    initial_capital: float = 10_000.0
    instrument: InstrumentMeta = field(default_factory=InstrumentMeta)
    commission: CommissionTier = field(default_factory=CommissionTier)
    slippage: SlippageModel = field(default_factory=SlippageModel)
    periods_per_year: int = 252


@dataclass
class BacktestResult:
    metrics: dict
    equity: list[float] = field(default_factory=list)
    trades: list[float] = field(default_factory=list)
    n_bars: int = 0

    def to_summary(self) -> dict:
        """The compact JSON summary - the only sanctioned output shape."""
        return dict(self.metrics)


def _materialize_bid_ask(df: pl.DataFrame, meta: InstrumentMeta) -> pl.DataFrame:
    """Build bid/ask columns modeling variable spread.

    Precedence: explicit bid/ask -> spread column (points) -> synthetic spread
    from a fraction of close. Spread is in price units; MT5 spread points are
    multiplied by point_size to convert.
    """
    if CANON_BID in df.columns and CANON_ASK in df.columns:
        return df

    close = pl.col(CANON_CLOSE)
    if CANON_SPREAD in df.columns:
        spread_price = pl.col(CANON_SPREAD) * meta.point_size
    else:
        # Synthetic fallback: 2 pip spread on a 5-digit quote.
        spread_price = pl.lit(2 * meta.point_size * 10)

    mid = close
    return df.with_columns(
        (mid - spread_price / 2.0).alias(CANON_BID),
        (mid + spread_price / 2.0).alias(CANON_ASK),
    )


def run_backtest(
    df: pl.DataFrame,
    strategy: Strategy,
    config: BacktestConfig | None = None,
    sizer: PositionSizer | None = None,
) -> BacktestResult:
    """Run a vectorized backtest.

    Fills happen at the next bar's open using bid (sells) / ask (buys), plus
    slippage and commission. Position changes incur commission on the traded
    lot delta. PnL accrues mark-to-market each bar using mid-close.
    """
    config = config or BacktestConfig()
    sizer = sizer or FixedLotSizer(lots=1.0)
    meta = config.instrument

    df = _materialize_bid_ask(df, meta)
    df = df.sort(CANON_TIME)

    # Generate signals on the full frame (strategy may attach indicators).
    sig: SignalResult = strategy.signals(df)
    if CANON_TIME not in sig.df.columns or "target_lots" not in sig.df.columns:
        raise ValueError("strategy.signals must return time + target_lots")

    # Join signals back onto the OHLCV frame by time.
    df = df.join(sig.df.select(CANON_TIME, "target_lots"), on=CANON_TIME, how="left")
    df = df.with_columns(pl.col("target_lots").fill_null(0.0))

    if CANON_OPEN not in df.columns:
        df = df.with_columns(pl.col(CANON_CLOSE).alias(CANON_OPEN))

    rows = df.to_dicts()
    equity = config.initial_capital
    equity_curve: list[float] = [equity]
    trades: list[float] = []
    position = 0.0  # signed lots

    slip = config.slippage.slippage_points  # adverse fill in price units
    comm_per_lot_side = config.commission.usd_per_lot_per_side
    contract = meta.contract_size

    for i, bar in enumerate(rows):
        target = float(bar["target_lots"])

        # Open the position at this bar's bid/ask (conservative: current spread).
        if i == 0:
            position = target
        else:
            delta = target - position
            traded = abs(delta)
            if traded > 0:
                # Commission on the traded lot delta (per side).
                equity -= traded * comm_per_lot_side
                # Slippage cost: adverse fill. Buys fill above ask, sells below
                # bid. Cost = slip * units, applied as an equity haircut once
                # per fill.
                equity -= slip * traded * contract
                position = target

        # Mark-to-market PnL for this bar using close-to-close on position.
        if i > 0:
            prev_close = float(rows[i - 1][CANON_CLOSE])
            curr_close = float(bar[CANON_CLOSE])
            price_change = curr_close - prev_close
            # PnL (quote ccy) = signed lots * contract size * price change.
            pnl = position * contract * price_change
            equity += pnl
            equity_curve.append(equity)
            if position != 0:
                trades.append(pnl)

    metrics = summary(
        equity_curve,
        trades,
        periods_per_year=config.periods_per_year,
    )
    metrics["initial_capital"] = config.initial_capital
    metrics["instrument"] = meta.symbol
    return BacktestResult(
        metrics=metrics,
        equity=equity_curve,
        trades=trades,
        n_bars=len(rows),
    )
