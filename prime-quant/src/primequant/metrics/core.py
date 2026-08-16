"""Performance metrics for FX/CFD backtests.

All functions accept equity curves or trade lists as plain arrays and return
floats. ``summary`` returns the compact JSON-ready dict the engine is allowed
to emit - this is the only sanctioned shape crossing the context boundary,
per the zero-raw-DataFrame-pollution constraint.
"""

from __future__ import annotations

from typing import Iterable

import numpy as np

# Annualization factor for FX: markets trade ~24h, ~252 trading days used as a
# conservative default. Callers may override via per_period->annual scaling.
TRADING_DAYS_PER_YEAR = 252
PERIODS_PER_YEAR = TRADING_DAYS_PER_YEAR  # default assumes daily equity bars


def _to_array(x: Iterable[float]) -> np.ndarray:
    arr = np.asarray(list(x), dtype=float)
    if arr.size == 0:
        return arr
    return arr


def returns(equity: Iterable[float]) -> np.ndarray:
    """Per-bar simple returns from an equity curve."""
    arr = _to_array(equity)
    if arr.size < 2:
        return np.array([])
    return np.diff(arr) / arr[:-1]


def sharpe_ratio(equity: Iterable[float], *, periods_per_year: int = PERIODS_PER_YEAR) -> float:
    r = returns(equity)
    if r.size < 2 or r.std() == 0:
        return 0.0
    return float(np.mean(r) / r.std(ddof=1) * np.sqrt(periods_per_year))


def sortino_ratio(equity: Iterable[float], *, periods_per_year: int = PERIODS_PER_YEAR) -> float:
    r = returns(equity)
    if r.size < 2:
        return 0.0
    downside = r[r < 0]
    if downside.size == 0:
        return 0.0
    dd_std = downside.std(ddof=1)
    if dd_std == 0:
        return 0.0
    return float(np.mean(r) / dd_std * np.sqrt(periods_per_year))


def max_drawdown_pct(equity: Iterable[float]) -> float:
    """Maximum peak-to-trough drawdown as a percentage (positive number)."""
    arr = _to_array(equity)
    if arr.size < 2:
        return 0.0
    running_max = np.maximum.accumulate(arr)
    dd = (arr - running_max) / running_max
    return float(-dd.min()) if dd.size else 0.0


def calmar_ratio(equity: Iterable[float], *, periods_per_year: int = PERIODS_PER_YEAR) -> float:
    """Annualized return / max drawdown."""
    arr = _to_array(equity)
    if arr.size < 2 or arr[0] <= 0:
        return 0.0
    mdd = max_drawdown_pct(arr)
    if mdd == 0:
        return 0.0
    total_return = arr[-1] / arr[0] - 1.0
    if total_return <= -1.0:
        # Equity at or below zero: annualized return is undefined.
        return 0.0
    years = arr.size / periods_per_year
    if years <= 0:
        return 0.0
    ann_return = (1.0 + total_return) ** (1.0 / years) - 1.0
    return float(ann_return / mdd)


def profit_factor(trades: Iterable[float]) -> float:
    """Sum of profits / sum of losses (absolute)."""
    arr = _to_array(trades)
    if arr.size == 0:
        return 0.0
    gross_profit = arr[arr > 0].sum()
    gross_loss = -arr[arr < 0].sum()
    if gross_loss == 0:
        return float("inf") if gross_profit > 0 else 0.0
    return float(gross_profit / gross_loss)


def win_rate(trades: Iterable[float]) -> float:
    arr = _to_array(trades)
    if arr.size == 0:
        return 0.0
    wins = int((arr > 0).sum())
    return float(wins / arr.size)


def expectancy(trades: Iterable[float]) -> float:
    """Average profit per trade."""
    arr = _to_array(trades)
    if arr.size == 0:
        return 0.0
    return float(arr.mean())


def summary(
    equity: Iterable[float],
    trades: Iterable[float] | None = None,
    *,
    periods_per_year: int = PERIODS_PER_YEAR,
) -> dict:
    """Compact JSON-ready metrics summary.

    This is the only shape permitted to leave the engine. No raw frames.
    """
    arr = _to_array(equity)
    t = _to_array(trades) if trades is not None else np.array([])
    return {
        "sharpe": sharpe_ratio(arr, periods_per_year=periods_per_year),
        "sortino": sortino_ratio(arr, periods_per_year=periods_per_year),
        "calmar": calmar_ratio(arr, periods_per_year=periods_per_year),
        "max_drawdown_pct": max_drawdown_pct(arr),
        "profit_factor": profit_factor(t),
        "win_rate": win_rate(t),
        "expectancy": expectancy(t),
        "n_trades": int(t.size),
        "final_equity": float(arr[-1]) if arr.size else 0.0,
    }
