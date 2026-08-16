"""Walk-forward analysis engine.

Runs a strategy across sequential train/test windows to simulate how it would
have performed had it been deployed in real time. Two window modes:

  - Rolling: a fixed-width train window slides forward by the test size each
    step (oldest data drops off).
  - Expanding: the train window grows; only the test window is fixed-width.

Each fold the strategy is fit on the train segment and evaluated out-of-sample
on the immediately-following test segment. There is no overlap between a
test segment and any train segment that informs the same fold, and an optional
embargo gap separates them to suppress autocorrelation leakage.

The runner is engine-agnostic: it takes a callable that turns a train frame
into a strategy, plus a backtest runner, so it composes with the vectorized
engine without coupling.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import polars as pl

from primequant.backtest.engine import BacktestConfig, BacktestResult, run_backtest
from primequant.data.loader import CANON_TIME
from primequant.strategy.base import Strategy

# A fit function produces a strategy from a training frame. This lets the
# caller recalibrate parameters per window (e.g. re-fit SMA windows).
FitFn = Callable[[pl.DataFrame], Strategy]


@dataclass(frozen=True)
class WalkForwardConfig:
    train_bars: int = 500
    test_bars: int = 100
    step_bars: int | None = None
    """How far to advance each fold. Defaults to test_bars (no test overlap)."""

    expanding: bool = False
    """If True, train grows from index 0; if False, train is a rolling window."""

    embargo_bars: int = 0
    """Gap bars dropped between train end and test start."""

    min_train_bars: int = 50


@dataclass
class WalkForwardFold:
    train_start: int
    train_end: int
    test_start: int
    test_end: int
    result: BacktestResult

    def to_summary(self) -> dict:
        return {
            "train_start": self.train_start,
            "train_end": self.train_end,
            "test_start": self.test_start,
            "test_end": self.test_end,
            "sharpe": self.result.metrics.get("sharpe", 0.0),
            "final_equity": self.result.metrics.get("final_equity", 0.0),
        }


@dataclass
class WalkForwardResult:
    folds: list[WalkForwardFold] = field(default_factory=list)

    @property
    def oos_sharpes(self) -> list[float]:
        return [f.result.metrics.get("sharpe", 0.0) for f in self.folds]

    def to_summary(self) -> dict:
        sharpes = self.oos_sharpes
        n = len(sharpes)
        pos = sum(1 for s in sharpes if s > 0)
        return {
            "n_folds": n,
            "oos_sharpe_mean": (sum(sharpes) / n) if n else 0.0,
            "positive_fold_rate": (pos / n) if n else 0.0,
            "folds": [f.to_summary() for f in self.folds],
        }


def _slices(n_bars: int, cfg: WalkForwardConfig) -> list[tuple[int, int, int, int]]:
    """Yield (train_start, train_end, test_start, test_end) index tuples."""
    step = cfg.step_bars or cfg.test_bars
    if step <= 0:
        raise ValueError("step_bars must be > 0")
    if cfg.test_bars <= 0:
        raise ValueError("test_bars must be > 0")
    if cfg.train_bars < cfg.min_train_bars and not cfg.expanding:
        raise ValueError(f"train_bars < min_train_bars ({cfg.min_train_bars})")

    folds: list[tuple[int, int, int, int]] = []
    test_start = cfg.train_bars
    while test_start + cfg.test_bars <= n_bars:
        if cfg.expanding:
            train_start = 0
            train_end = test_start
        else:
            train_end = test_start
            train_start = max(0, train_end - cfg.train_bars)
        if train_end - train_start < cfg.min_train_bars:
            break
        # Embargo gap between train and test.
        ts = test_start + cfg.embargo_bars
        te = ts + cfg.test_bars
        if te > n_bars:
            break
        folds.append((train_start, train_end, ts, te))
        test_start += step
    return folds


def run_walk_forward(
    df: pl.DataFrame,
    fit_fn: FitFn,
    config: WalkForwardConfig | None = None,
    backtest_config: BacktestConfig | None = None,
) -> WalkForwardResult:
    """Run rolling or expanding walk-forward validation.

    ``fit_fn(train_df) -> Strategy`` is called on each training segment; the
    returned strategy is backtested on the following test segment. The
    returned ``WalkForwardResult.oos_sharpes`` are the per-fold OOS Sharpes.
    """
    config = config or WalkForwardConfig()
    df = df.sort(CANON_TIME)
    rows = df.to_dicts()
    cols = list(df.columns)
    n = len(rows)

    slices = _slices(n, config)
    if not slices:
        return WalkForwardResult(folds=[])

    folds: list[WalkForwardFold] = []
    for tr_s, tr_e, te_s, te_e in slices:
        train_df = pl.DataFrame(rows[tr_s:tr_e], schema=df.schema)
        test_df = pl.DataFrame(rows[te_s:te_e], schema=df.schema)
        if train_df.height == 0 or test_df.height == 0:
            continue
        strategy = fit_fn(train_df)
        result = run_backtest(test_df, strategy, config=backtest_config)
        folds.append(
            WalkForwardFold(
                train_start=tr_s,
                train_end=tr_e,
                test_start=te_s,
                test_end=te_e,
                result=result,
            )
        )
    return WalkForwardResult(folds=folds)
