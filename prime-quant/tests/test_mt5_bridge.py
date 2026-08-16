"""Unit and Integration Tests for Native Windows MetaTrader 5 IPC Bridge (MT5Bridge)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import pytest

from primequant.data.mt5 import (
    CANONICAL_MT5_COLUMNS,
    MT5Bridge,
    resolve_timeframe,
)


@dataclass
class MockSymbol:
    name: str


@dataclass
class MockSymbolInfo:
    name: str = "EURUSD"
    trade_contract_size: float = 100000.0
    point: float = 0.00001
    digits: int = 5
    volume_min: float = 0.01
    volume_max: float = 100.0
    volume_step: float = 0.01
    swap_long: float = -0.5
    swap_short: float = 0.1
    swap_mode: int = 1
    spread: int = 12
    spread_float: bool = True
    bid: float = 1.08500
    ask: float = 1.08512
    trade_tick_value: float = 1.0
    trade_tick_size: float = 0.00001
    currency_base: str = "EUR"
    currency_profit: str = "USD"
    currency_margin: str = "EUR"


@dataclass
class MockTick:
    time: int = 1700000000
    bid: float = 1.08500
    ask: float = 1.08512
    last: float = 1.08505
    volume: float = 1.5
    flags: int = 6


class MockMT5:
    """Mock MetaTrader 5 module for offline unit testing."""

    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 16385
    TIMEFRAME_H4 = 16388
    TIMEFRAME_D1 = 16408
    TIMEFRAME_W1 = 32769
    TIMEFRAME_MN1 = 49153
    COPY_TICKS_ALL = -1

    def __init__(self, init_success: bool = True):
        self.init_success = init_success
        self.initialized = False
        self.shutdown_called = False
        self.symbols = [
            MockSymbol("EURUSD"),
            MockSymbol("GBPUSD"),
            MockSymbol("USDJPY"),
            MockSymbol("XAUUSD"),
        ]
        self.available_symbols = {"EURUSD", "GBPUSD", "USDJPY", "XAUUSD"}
        self.selected_symbols: set[str] = set()

    def initialize(self, **kwargs) -> bool:
        if self.init_success:
            self.initialized = True
            return True
        return False

    def shutdown(self) -> None:
        self.shutdown_called = True
        self.initialized = False

    def last_error(self) -> tuple[int, str]:
        return (1, "Mock MT5 Error description")

    def symbol_select(self, symbol: str, enable: bool) -> bool:
        if symbol in self.available_symbols:
            if enable:
                self.selected_symbols.add(symbol)
            else:
                self.selected_symbols.discard(symbol)
            return True
        return False

    def symbols_get(self) -> list[MockSymbol]:
        return self.symbols

    def symbol_info(self, symbol: str) -> MockSymbolInfo | None:
        if symbol in self.available_symbols:
            return MockSymbolInfo(name=symbol)
        return None

    def symbol_info_tick(self, symbol: str) -> MockTick | None:
        if symbol in self.available_symbols:
            return MockTick()
        return None

    def copy_rates_range(
        self, symbol: str, timeframe: int, date_from: datetime, date_to: datetime
    ) -> np.ndarray | None:
        if symbol not in self.available_symbols:
            return None

        # Generate 10 mock bars
        start_ts = int(date_from.timestamp()) if hasattr(date_from, "timestamp") else 1700000000
        step = 3600 if timeframe == self.TIMEFRAME_H1 else 60

        dtype = [
            ("time", "i8"),
            ("open", "f8"),
            ("high", "f8"),
            ("low", "f8"),
            ("close", "f8"),
            ("tick_volume", "u8"),
            ("spread", "i4"),
            ("real_volume", "u8"),
        ]
        data = []
        for i in range(10):
            t = start_ts + i * step
            o = 1.0800 + i * 0.0010
            h = o + 0.0020
            l = o - 0.0010
            c = o + 0.0005
            vol = 100 + i * 10
            spread = 12
            real_vol = 0
            data.append((t, o, h, l, c, vol, spread, real_vol))

        return np.array(data, dtype=dtype)

    def copy_ticks_range(
        self, symbol: str, date_from: datetime, date_to: datetime, flags: int
    ) -> np.ndarray | None:
        if symbol not in self.available_symbols:
            return None

        start_ts = int(date_from.timestamp()) if hasattr(date_from, "timestamp") else 1700000000
        dtype = [
            ("time", "i8"),
            ("bid", "f8"),
            ("ask", "f8"),
            ("last", "f8"),
            ("volume", "f8"),
            ("time_msc", "i8"),
            ("flags", "u4"),
        ]
        data = [
            (start_ts + i, 1.0850 + i * 0.0001, 1.0851 + i * 0.0001, 1.0850, 1.0, (start_ts + i) * 1000, 6)
            for i in range(5)
        ]
        return np.array(data, dtype=dtype)


# ---------------------------------------------------------------------------
# Unit Tests (Mocked)
# ---------------------------------------------------------------------------


def test_timeframe_resolution():
    tf_int, label = resolve_timeframe("1m")
    assert tf_int == 1
    assert label == "1M"

    tf_int, label = resolve_timeframe("1h")
    assert tf_int == 16385
    assert label == "1H"

    tf_int, label = resolve_timeframe("4h")
    assert tf_int == 16388
    assert label == "4H"

    tf_int, label = resolve_timeframe("1d")
    assert tf_int == 16408
    assert label == "1D"

    tf_int, label = resolve_timeframe("MN1")
    assert tf_int == 49153
    assert label == "MN1"

    tf_int, label = resolve_timeframe(16385)
    assert tf_int == 16385
    assert label == "H1"

    with pytest.raises(ValueError, match="Unsupported timeframe"):
        resolve_timeframe("invalid_tf")


def test_bridge_lifecycle_and_context_manager():
    mock_mt5 = MockMT5(init_success=True)
    bridge = MT5Bridge(mt5_module=mock_mt5)

    assert not bridge.is_connected
    assert bridge.initialize() is True
    assert bridge.is_connected
    assert mock_mt5.initialized

    bridge.shutdown()
    assert not bridge.is_connected
    assert mock_mt5.shutdown_called

    # Test context manager
    with MT5Bridge(mt5_module=mock_mt5) as b:
        assert b.is_connected
    assert not b.is_connected


def test_bridge_init_failure():
    mock_mt5 = MockMT5(init_success=False)
    bridge = MT5Bridge(mt5_module=mock_mt5)
    assert bridge.initialize() is False
    assert not bridge.is_connected


def test_bridge_query_without_init_raises():
    mock_mt5 = MockMT5(init_success=True)
    bridge = MT5Bridge(mt5_module=mock_mt5)
    with pytest.raises(ConnectionError, match="MT5Bridge is not initialized"):
        bridge.get_symbol_info("EURUSD")


def test_symbol_selection_guard_missing_symbol():
    mock_mt5 = MockMT5(init_success=True)
    bridge = MT5Bridge(mt5_module=mock_mt5)
    bridge.initialize()

    # Query a non-existent symbol with similarity matching
    with pytest.raises(ValueError, match="Symbol 'EURJPY' could not be selected in MetaTrader 5 Market Watch"):
        bridge.get_symbol_info("EURJPY")


def test_get_symbol_info():
    mock_mt5 = MockMT5(init_success=True)
    bridge = MT5Bridge(mt5_module=mock_mt5)
    bridge.initialize()

    info = bridge.get_symbol_info("EURUSD")
    assert isinstance(info, dict)
    assert info["symbol"] == "EURUSD"
    assert info["contract_size"] == 100000.0
    assert info["point"] == 0.00001
    assert info["digits"] == 5
    assert info["min_lot"] == 0.01
    assert info["max_lot"] == 100.0
    assert info["lot_step"] == 0.01
    assert info["swap_long"] == -0.5
    assert info["swap_short"] == 0.1
    assert info["spread"] == 12
    # Adverse spread = 12 * 0.00001 = 0.00012
    assert pytest.approx(info["adverse_spread"], rel=1e-5) == 0.00012
    assert info["bid"] == 1.08500
    assert info["ask"] == 1.08512


def test_get_historical_ohlcv_schema_epoch_and_cache(tmp_path: Path):
    mock_mt5 = MockMT5(init_success=True)
    bridge = MT5Bridge(mt5_module=mock_mt5)
    bridge.initialize()

    cache_dir = tmp_path / "cache"
    date_from = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    date_to = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

    df = bridge.get_historical_ohlcv(
        symbol="EURUSD",
        timeframe="1h",
        date_from=date_from,
        date_to=date_to,
        cache=True,
        cache_dir=cache_dir,
    )

    # 1. Schema check
    assert df.columns == CANONICAL_MT5_COLUMNS
    assert df.schema["time"] == pl.Datetime("us")
    assert df.schema["open"] == pl.Float64
    assert df.schema["high"] == pl.Float64
    assert df.schema["low"] == pl.Float64
    assert df.schema["close"] == pl.Float64
    assert df.schema["tick_volume"] == pl.Int64
    assert df.schema["spread"] == pl.Int64
    assert df.height == 10
    assert df["time"].is_sorted()

    # 2. Timestamp check: epoch conversion
    first_time = df["time"][0]
    assert first_time.year == 2024
    assert first_time.month == 1
    assert first_time.day == 1

    # 3. Disk cache check
    expected_cache_file = cache_dir / "EURUSD_1H.parquet"
    assert expected_cache_file.exists()
    cached_df = pl.read_parquet(expected_cache_file)
    assert cached_df.equals(df)


def test_get_last_tick():
    mock_mt5 = MockMT5(init_success=True)
    bridge = MT5Bridge(mt5_module=mock_mt5)
    bridge.initialize()

    tick = bridge.get_last_tick("EURUSD")
    assert tick is not None
    assert isinstance(tick["time"], datetime)
    assert tick["bid"] == 1.08500
    assert tick["ask"] == 1.08512
    assert tick["last"] == 1.08505
    assert tick["volume"] == 1.5
    assert tick["flags"] == 6


def test_get_historical_ticks():
    mock_mt5 = MockMT5(init_success=True)
    bridge = MT5Bridge(mt5_module=mock_mt5)
    bridge.initialize()

    ticks = bridge.get_historical_ticks(
        symbol="EURUSD",
        date_from="2024-01-01 00:00:00",
        date_to="2024-01-01 01:00:00",
    )
    assert isinstance(ticks, pl.DataFrame)
    assert "time" in ticks.columns
    assert "bid" in ticks.columns
    assert "ask" in ticks.columns
    assert ticks.schema["time"] == pl.Datetime("us")
    assert ticks.height == 5


# ---------------------------------------------------------------------------
# Live Smoke Test Hook
# ---------------------------------------------------------------------------


def test_live_mt5_smoke_hook():
    """Live smoke test hook: executes against real MT5 if terminal is detected running."""
    try:
        import MetaTrader5 as mt5
    except (ImportError, ModuleNotFoundError):
        pytest.skip("MetaTrader5 package not available in this environment.")

    bridge = MT5Bridge()
    if not bridge.initialize():
        pytest.skip("Live MetaTrader 5 terminal not running or unreachable on local machine.")

    try:
        # Check if connected to account and broker
        symbols = mt5.symbols_get()
        if not symbols or len(symbols) == 0:
            pytest.skip("Connected to MT5, but no symbols available.")

        test_symbol = symbols[0].name
        info = bridge.get_symbol_info(test_symbol)
        assert info["symbol"] == test_symbol
        assert info["contract_size"] > 0
        assert info["point"] > 0

        # Query recent bar
        now = datetime.now(timezone.utc)
        start = datetime.fromtimestamp(now.timestamp() - 86400 * 7, tz=timezone.utc)
        try:
            bars = bridge.get_historical_ohlcv(
                symbol=test_symbol,
                timeframe="1h",
                date_from=start,
                date_to=now,
                cache=False,
            )
            assert isinstance(bars, pl.DataFrame)
            assert "time" in bars.columns
            assert "close" in bars.columns
        except ValueError as err:
            # Weekend/off-hours or no history for first symbol
            pass
    finally:
        bridge.shutdown()
