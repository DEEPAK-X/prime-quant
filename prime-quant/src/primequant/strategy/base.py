"""Strategy interfaces.

A Strategy produces integer target-position signals (-1/0/+1 lots, or any
signed multiple of lots) from OHLCV data, plus a position sizer that converts
raw signals into lot-sized target positions given account equity and risk
parameters. The engine never calls into strategy internals beyond these two
methods, so strategies are trivially composable and testable.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import polars as pl

from primequant.data.loader import CANON_CLOSE, CANON_TIME


@dataclass(frozen=True)
class SignalResult:
    """Per-bar target position in lots (signed). Positive = long."""

    df: pl.DataFrame  # carries 'time' and 'target_lots' columns

    def positions(self) -> pl.Series:
        return self.df["target_lots"]


class PositionSizer(ABC):
    """Convert a raw signal direction into a lot-sized target position."""

    @abstractmethod
    def size(self, df: pl.DataFrame, signal_col: str, equity: float) -> pl.Series:
        """Return a Series of target lots aligned to df rows."""


@dataclass
class FixedLotSizer(PositionSizer):
    """Always trade a fixed lot count regardless of equity."""

    lots: float = 1.0

    def size(self, df: pl.DataFrame, signal_col: str, equity: float) -> pl.Series:
        return df[signal_col].cast(pl.Float64) * self.lots


@dataclass
class RiskFractionSizer(PositionSizer):
    """Size lots so risk per trade is a fixed fraction of equity.

    risk_per_lot is the monetary loss if price moves by one 'risk_distance'
    unit (e.g. one ATR) for a single lot. Computed externally and passed in
    per-bar via ``risk_per_lot_col``.
    """

    risk_fraction: float = 0.01  # 1% of equity per trade
    max_lots: float = 10.0
    risk_per_lot_col: str = "risk_per_lot"

    def size(self, df: pl.DataFrame, signal_col: str, equity: float) -> pl.Series:
        if self.risk_per_lot_col not in df.columns:
            raise ValueError(f"missing risk column {self.risk_per_lot_col}")
        risk_budget = equity * self.risk_fraction
        lots = df[self.risk_per_lot_col].cast(pl.Float64).map_elements(
            lambda r: min(self.max_lots, risk_budget / r) if r and r > 0 else 0.0,
            return_dtype=pl.Float64,
        )
        sign = df[signal_col].cast(pl.Float64).sign()
        return (lots * sign).round(2)


class Strategy(ABC):
    """Base strategy interface. Implement ``signals`` to emit target lots."""

    name: str = "base"

    @abstractmethod
    def signals(self, df: pl.DataFrame) -> SignalResult:
        """Return a SignalResult with a 'target_lots' column aligned to df."""

    def prepare(self, df: pl.DataFrame) -> pl.DataFrame:
        """Hook to attach indicators. Default: return df unchanged."""
        return df


@dataclass
class MomentumStrategy(Strategy):
    """Simple SMA crossover momentum strategy.

    Long when fast SMA > slow SMA, flat otherwise. Generates discrete
    +1/0 target lots; pair with FixedLotSizer for the reference backtest.
    """

    fast: int = 10
    slow: int = 30
    name: str = "momentum"

    def prepare(self, df: pl.DataFrame) -> pl.DataFrame:
        return df.with_columns(
            pl.col(CANON_CLOSE).rolling_mean(self.fast).alias("sma_fast"),
            pl.col(CANON_CLOSE).rolling_mean(self.slow).alias("sma_slow"),
        )

    def signals(self, df: pl.DataFrame) -> SignalResult:
        prepared = self.prepare(df)
        target = (
            pl.when(pl.col("sma_fast") > pl.col("sma_slow"))
            .then(1.0)
            .otherwise(0.0)
        )
        out = prepared.with_columns(target.alias("target_lots"))
        return SignalResult(df=out.select(CANON_TIME, "target_lots"))
