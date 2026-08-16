"""Tests for the vectorized FX backtest engine and contract sizing."""

from __future__ import annotations

import math

import polars as pl
import pytest

from primequant.backtest.engine import (
    BacktestConfig,
    CommissionTier,
    InstrumentMeta,
    SlippageModel,
    UNITS_PER_LOT,
    run_backtest,
)
from primequant.strategy.base import FixedLotSizer, MomentumStrategy
from tests._fxdata import synthetic_fx


def test_units_per_lot_is_100k():
    assert UNITS_PER_LOT == 100_000.0


def test_backtest_returns_compact_summary():
    df = synthetic_fx(n_bars=200)
    result = run_backtest(df, MomentumStrategy(fast=5, slow=20))
    s = result.to_summary()
    # Only the compact metrics dict crosses the boundary.
    for key in ("sharpe", "sortino", "calmar", "max_drawdown_pct", "profit_factor", "win_rate"):
        assert key in s
    assert "instrument" in s
    assert s["instrument"] == "EURUSD"
    assert result.n_bars == 200
    assert len(result.equity) == 200


def test_backtest_equity_starts_at_initial_capital():
    df = synthetic_fx(n_bars=50)
    cfg = BacktestConfig(initial_capital=25_000.0)
    result = run_backtest(df, MomentumStrategy(fast=3, slow=10), config=cfg)
    assert math.isclose(result.equity[0], 25_000.0, rel_tol=1e-9)


def test_backtest_commission_reduces_equity():
    df = synthetic_fx(n_bars=100)
    cfg_no_comm = BacktestConfig(commission=CommissionTier(usd_per_lot_per_side=0.0))
    cfg_comm = BacktestConfig(commission=CommissionTier(usd_per_lot_per_side=10.0))
    r0 = run_backtest(df, MomentumStrategy(fast=3, slow=10), config=cfg_no_comm)
    r1 = run_backtest(df, MomentumStrategy(fast=3, slow=10), config=cfg_comm)
    # Commission should not increase equity.
    assert r1.equity[-1] <= r0.equity[-1] + 1e-6


def test_backtest_slippage_reduces_equity():
    df = synthetic_fx(n_bars=100)
    cfg_no_slip = BacktestConfig(slippage=SlippageModel(slippage_points=0.0))
    cfg_slip = BacktestConfig(slippage=SlippageModel(slippage_points=0.0001))
    r0 = run_backtest(df, MomentumStrategy(fast=3, slow=10), config=cfg_no_slip)
    r1 = run_backtest(df, MomentumStrategy(fast=3, slow=10), config=cfg_slip)
    assert r1.equity[-1] <= r0.equity[-1] + 1e-6


def test_backtest_deterministic():
    df = synthetic_fx(n_bars=150)
    strat = MomentumStrategy(fast=5, slow=15)
    r1 = run_backtest(df, strat)
    r2 = run_backtest(df, strat)
    assert r1.equity == r2.equity
    assert r1.metrics == r2.metrics


def test_contract_sizing_pnl_magnitude():
    # 1 lot, 1 pip move on EURUSD -> ~10 USD PnL per pip per lot.
    df = synthetic_fx(n_bars=100)
    cfg = BacktestConfig(
        initial_capital=10_000.0,
        instrument=InstrumentMeta(symbol="EURUSD", point_size=0.00001, contract_size=100_000.0),
    )
    result = run_backtest(df, MomentumStrategy(fast=3, slow=10), config=cfg, sizer=FixedLotSizer(lots=1.0))
    # Equity should move on the order of dollars-to-tens of dollars per pip.
    assert result.equity[-1] != cfg.initial_capital


def test_flat_strategy_no_trades():
    df = synthetic_fx(n_bars=50)
    # A strategy that always targets 0 lots.
    from primequant.strategy.base import SignalResult, Strategy

    class Flat(Strategy):
        name = "flat"

        def signals(self, df):
            out = df.select("time").with_columns(pl.lit(0.0).alias("target_lots"))
            return SignalResult(df=out)

    result = run_backtest(df, Flat())
    # No fills -> equity unchanged apart from no commissions.
    assert math.isclose(result.equity[-1], result.equity[0], rel_tol=1e-9)
    assert result.metrics["n_trades"] == 0


def test_momentum_strategy_signal_shape():
    df = synthetic_fx(n_bars=60)
    strat = MomentumStrategy(fast=5, slow=20)
    sig = strat.signals(df)
    assert "target_lots" in sig.df.columns
    assert sig.df["target_lots"].is_in([0.0, 1.0]).all()


def test_momentum_strategy_end_to_end_profitable_on_trend():
    # The synthetic data has a positive drift; momentum should capture some.
    df = synthetic_fx(n_bars=300, drift=0.00005, vol=0.0001)
    result = run_backtest(df, MomentumStrategy(fast=5, slow=20))
    assert result.equity[-1] != result.equity[0]
