"""Tests for metrics functions."""

from __future__ import annotations

import math

import pytest

from primequant.metrics.core import (
    calmar_ratio,
    expectancy,
    max_drawdown_pct,
    profit_factor,
    returns,
    sharpe_ratio,
    sortino_ratio,
    summary,
    win_rate,
)


def test_returns_empty_for_short_curve():
    assert returns([100.0]).size == 0
    assert returns([]).size == 0


def test_returns_basic():
    r = returns([100.0, 110.0, 99.0])
    assert math.isclose(r[0], 0.1, rel_tol=1e-9)
    assert math.isclose(r[1], -0.1, rel_tol=1e-9)


def test_sharpe_zero_for_flat():
    assert sharpe_ratio([100, 100, 100]) == 0.0


def test_sharpe_positive_for_gains():
    eq = [100 * (1.001 ** i) for i in range(50)]
    assert sharpe_ratio(eq) > 0


def test_sortino_no_downside_returns_zero():
    eq = [100 + i for i in range(50)]
    # monotonically increasing -> no downside -> 0
    assert sortino_ratio(eq) == 0.0


def test_max_drawdown_pct():
    eq = [100, 120, 90, 95]
    # peak 120 -> trough 90 = 25% dd
    assert math.isclose(max_drawdown_pct(eq), 0.25, rel_tol=1e-9)


def test_max_drawdown_no_drawdown():
    eq = [100, 110, 120]
    assert max_drawdown_pct(eq) == 0.0


def test_calmar_basic():
    eq = [100, 150, 120, 130]
    mdd = max_drawdown_pct(eq)
    assert mdd > 0
    assert calmar_ratio(eq) >= 0


def test_profit_factor():
    trades = [10, -5, 20, -10]
    # gross profit 30 / gross loss 15 = 2.0
    assert math.isclose(profit_factor(trades), 2.0, rel_tol=1e-9)


def test_profit_factor_no_losses():
    assert profit_factor([10, 20]) == float("inf")
    assert profit_factor([]) == 0.0


def test_win_rate():
    trades = [1, -1, 2, -3, 4]
    assert math.isclose(win_rate(trades), 0.6, rel_tol=1e-9)


def test_expectancy():
    trades = [10, -5, 20]
    assert math.isclose(expectancy(trades), 25 / 3, rel_tol=1e-9)


def test_summary_shape():
    eq = [100 * (1.001 ** i) for i in range(60)]
    trades = [1, -2, 3, 1, -1]
    s = summary(eq, trades)
    for key in (
        "sharpe",
        "sortino",
        "calmar",
        "max_drawdown_pct",
        "profit_factor",
        "win_rate",
        "expectancy",
        "n_trades",
        "final_equity",
    ):
        assert key in s
    assert s["n_trades"] == 5
    assert isinstance(s["sharpe"], float)
