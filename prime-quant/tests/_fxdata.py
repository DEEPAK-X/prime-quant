"""Shared synthetic FX data fixtures for tests.

Deterministic so backtest results are reproducible. Generates EURUSD-like
5-digit OHLCV with a realistic spread column.
"""

from __future__ import annotations

from datetime import datetime, timedelta

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
    CANON_VOLUME,
)


def synthetic_fx(
    n_bars: int = 300,
    start: datetime | None = None,
    freq_seconds: int = 3600,
    base_price: float = 1.10000,
    drift: float = 0.00002,
    vol: float = 0.00015,
    seed: int = 42,
) -> pl.DataFrame:
    """Deterministic random-walk FX OHLCV with spread in points."""
    import random

    rng = random.Random(seed)
    start = start or datetime(2024, 1, 1)
    times = [start + timedelta(seconds=freq_seconds * i) for i in range(n_bars)]

    closes: list[float] = [base_price]
    for _ in range(1, n_bars):
        # Skewed random walk to give momentum strategies a detectable trend.
        ret = drift + rng.gauss(0, vol)
        closes.append(round(closes[-1] * (1 + ret), 5))

    opens = [closes[0]] + closes[:-1]
    highs = [max(o, c) + abs(rng.gauss(0, vol * 0.3)) for o, c in zip(opens, closes)]
    lows = [min(o, c) - abs(rng.gauss(0, vol * 0.3)) for o, c in zip(opens, closes)]
    spreads = [int(rng.uniform(5, 15)) for _ in range(n_bars)]  # points
    volumes = [rng.uniform(100, 1000) for _ in range(n_bars)]

    return pl.DataFrame(
        {
            CANON_TIME: times,
            CANON_OPEN: opens,
            CANON_HIGH: highs,
            CANON_LOW: lows,
            CANON_CLOSE: closes,
            CANON_VOLUME: volumes,
            CANON_SPREAD: spreads,
        }
    )


def synthetic_fx_with_bid_ask(n_bars: int = 300, seed: int = 42) -> pl.DataFrame:
    df = synthetic_fx(n_bars=n_bars, seed=seed)
    point = 0.00001
    spread_price = pl.col(CANON_SPREAD) * point
    return df.with_columns(
        (pl.col(CANON_CLOSE) - spread_price / 2).alias(CANON_BID),
        (pl.col(CANON_CLOSE) + spread_price / 2).alias(CANON_ASK),
    )
