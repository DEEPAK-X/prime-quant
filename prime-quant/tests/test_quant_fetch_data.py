"""Tests for the quant skill's live MT5 fetch_data card (mocked IPC)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import numpy as np
import pytest

from quant.data import fetch_data


class FakeMT5:
    """Minimal MetaTrader5 module double exposing copy_rates_from."""

    TIMEFRAME_M5 = 5

    def __init__(self, init_success: bool = True, n_bars: int = 10):
        self.init_success = init_success
        self.n_bars = n_bars
        self.initialize_kwargs: dict[str, Any] | None = None
        self.shutdown_called = False

    def initialize(self, **kwargs) -> bool:
        self.initialize_kwargs = kwargs
        return self.init_success

    def shutdown(self) -> None:
        self.shutdown_called = True

    def last_error(self) -> tuple[int, str]:
        return (1, "fake MT5 error")

    def symbol_select(self, symbol: str, enable: bool) -> bool:
        return symbol == "EURUSD"

    def copy_rates_from(self, symbol: str, timeframe: int, from_dt: Any, count: int):
        if symbol != "EURUSD":
            return None
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
        base_ts = 1704067200  # 2024-01-01 00:00:00 UTC
        rows = []
        for i in range(min(count, self.n_bars)):
            t = base_ts + i * 300
            o = 1.1000 + i * 0.0001
            rows.append((t, o, o + 0.0002, o - 0.0001, o + 0.0001, 100 + i, 12, 0))
        return np.array(rows, dtype=dtype)


def _run(**kwargs: Any) -> tuple[dict[str, Any], dict[str, Any], FakeMT5]:
    fake = kwargs.pop("mt5_module")
    ns: dict[str, Any] = {}
    card_json = asyncio.run(fetch_data(namespace=ns, mt5_module=fake, **kwargs))
    return json.loads(card_json), ns, fake


def test_fetch_data_success_card_and_bindings():
    card, ns, fake = _run(symbol="EURUSD", timeframe="M5", bars=10, mt5_module=FakeMT5())

    assert card["status"] == "success"
    assert card["symbol"] == "EURUSD"
    assert card["timeframe"] == "M5"
    assert card["rows"] == 10
    assert card["qa"]["ok"] is True
    assert card["qa"]["error_count"] == 0
    assert len(card["range"]) == 2
    assert card["range"][0].startswith("2024-01-01")

    # Frame is bound to kernel scope, with the loader-canonical volume column.
    df = ns["_last_df"]
    assert ns["df"] is df
    assert "volume" in df.columns
    assert "tick_volume" not in df.columns
    assert df.height == 10

    assert fake.shutdown_called


def test_fetch_data_no_cache_write(tmp_path):
    card, _, _ = _run(
        symbol="EURUSD", timeframe="M5", bars=5, cache=False, mt5_module=FakeMT5()
    )
    assert card["cache"] is None
    assert list(tmp_path.iterdir()) == []


def test_fetch_data_connection_failure_returns_error_card():
    card, ns, fake = _run(symbol="EURUSD", timeframe="M5", mt5_module=FakeMT5(init_success=False))

    assert card["status"] == "error"
    assert "mt5.initialize failed" in card["error"]["message"]
    assert "_last_df" not in ns


def test_fetch_data_env_overrides_reach_initialize(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PRIME_QUANT_MT5_PATH", r"C:\Program Files\MetaTrader 5\terminal64.exe")
    monkeypatch.setenv("PRIME_QUANT_MT5_LOGIN", "12345678")
    monkeypatch.setenv("PRIME_QUANT_MT5_TIMEOUT", "90000")
    monkeypatch.delenv("PRIME_QUANT_MT5_PASSWORD", raising=False)

    _, _, fake = _run(symbol="EURUSD", timeframe="M5", mt5_module=FakeMT5())
    assert fake.initialize_kwargs == {
        "path": r"C:\Program Files\MetaTrader 5\terminal64.exe",
        "login": 12345678,
        "timeout": 90000,
    }


def test_fetch_data_env_bad_login_is_input_error(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PRIME_QUANT_MT5_LOGIN", "not-a-number")

    card, _, _ = _run(symbol="EURUSD", timeframe="M5", mt5_module=FakeMT5())
    assert card["status"] == "error"
    assert "PRIME_QUANT_MT5_LOGIN" in card["error"]["message"]


def test_fetch_data_unknown_symbol_returns_error_card():
    card, ns, _ = _run(symbol="ZZZUSD", timeframe="M5", mt5_module=FakeMT5())
    assert card["status"] == "error"
    assert "_last_df" not in ns
