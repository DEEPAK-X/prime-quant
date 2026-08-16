"""Native Windows MetaTrader 5 IPC Bridge.

Connects directly to a running MetaTrader 5 terminal instance on Windows to
extract historical OHLCV bars, live ticks, and broker trading costs with
built-in market watch guards, epoch timestamp normalization, and caching.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import polars as pl

# Standard MT5 timeframe constants fallback map if MetaTrader5 module constants are queried.
TIMEFRAME_MAP: dict[str, int] = {
    "M1": 1,
    "1M": 1,  # case-insensitive check handled in resolver
    "1MIN": 1,
    "M2": 2,
    "2M": 2,
    "M3": 3,
    "3M": 3,
    "M4": 4,
    "4M": 4,
    "M5": 5,
    "5M": 5,
    "5MIN": 5,
    "M6": 6,
    "6M": 6,
    "M10": 10,
    "10M": 10,
    "M12": 12,
    "12M": 12,
    "M15": 15,
    "15M": 15,
    "15MIN": 15,
    "M20": 20,
    "20M": 20,
    "M30": 30,
    "30M": 30,
    "30MIN": 30,
    "H1": 16385,
    "1H": 16385,
    "1HOUR": 16385,
    "60M": 16385,
    "H2": 16386,
    "2H": 16386,
    "H3": 16387,
    "3H": 16387,
    "H4": 16388,
    "4H": 16388,
    "H6": 16390,
    "6H": 16390,
    "H8": 16392,
    "8H": 16392,
    "H12": 16396,
    "12H": 16396,
    "D1": 16408,
    "1D": 16408,
    "1DAY": 16408,
    "W1": 32769,
    "1W": 32769,
    "1WEEK": 32769,
    "MN1": 49153,
    "1MO": 49153,
    "1MONTH": 49153,
}

CANONICAL_MT5_COLUMNS = [
    "time",
    "open",
    "high",
    "low",
    "close",
    "tick_volume",
    "spread",
]


def resolve_timeframe(tf: str | int, mt5_mod: Any = None) -> tuple[int, str]:
    """Resolve a timeframe input into (mt5_timeframe_int, normalized_str)."""
    if isinstance(tf, int):
        # Look up string representation if available
        name = next((k for k, v in TIMEFRAME_MAP.items() if v == tf and k.startswith(("M", "H", "D", "W", "MN"))), f"TF_{tf}")
        return tf, name

    tf_str = str(tf).strip().upper()
    if tf_str in TIMEFRAME_MAP:
        return TIMEFRAME_MAP[tf_str], tf_str

    if mt5_mod is not None:
        attr_name = f"TIMEFRAME_{tf_str}"
        if hasattr(mt5_mod, attr_name):
            val = getattr(mt5_mod, attr_name)
            return int(val), tf_str

    raise ValueError(
        f"Unsupported timeframe '{tf}'. Valid examples: '1m', '5m', '15m', '30m', '1h', '4h', '1d', 'M1', 'H1', 'D1'."
    )


def _to_datetime(dt: datetime | date | str | int | float) -> datetime:
    """Normalize input into a datetime object."""
    if isinstance(dt, datetime):
        return dt
    if isinstance(dt, date):
        return datetime.combine(dt, datetime.min.time())
    if isinstance(dt, (int, float)):
        return datetime.fromtimestamp(dt, tz=timezone.utc)
    if isinstance(dt, str):
        # Try ISO parsing
        try:
            return datetime.fromisoformat(dt)
        except ValueError:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d"):
                try:
                    return datetime.strptime(dt, fmt)
                except ValueError:
                    continue
            raise ValueError(f"Unable to parse datetime string '{dt}'")
    raise TypeError(f"Unsupported datetime type: {type(dt)}")


class MT5Bridge:
    """MetaTrader 5 IPC Bridge for Windows 11.

    Connects directly to the local MT5 process to fetch historical rates, live ticks,
    and broker symbol specifications with automatic caching and validation guards.
    """

    def __init__(self, mt5_module: Any = None):
        self._mt5 = mt5_module
        self._connected: bool = False

    @property
    def is_connected(self) -> bool:
        return self._connected

    def _get_mt5(self) -> Any:
        """Lazy-import or return injected MetaTrader5 module."""
        if self._mt5 is not None:
            return self._mt5

        try:
            import MetaTrader5 as mt5
            self._mt5 = mt5
            return self._mt5
        except (ImportError, ModuleNotFoundError) as err:
            raise RuntimeError(
                "MetaTrader5 Python package is required for MT5Bridge. "
                "Install it via 'pip install MetaTrader5'. "
                "Note: MT5 IPC requires Windows and an installed MetaTrader 5 terminal."
            ) from err

    def initialize(
        self,
        path: str | Path | None = None,
        portable: bool = False,
        login: int | None = None,
        password: str | None = None,
        server: str | None = None,
        timeout: int | None = None,
    ) -> bool:
        """Connect to the local MetaTrader 5 terminal instance."""
        mt5 = self._get_mt5()

        init_kwargs: dict[str, Any] = {}
        if path is not None:
            init_kwargs["path"] = str(path)
        if portable:
            init_kwargs["portable"] = True
        if login is not None:
            init_kwargs["login"] = int(login)
        if password is not None:
            init_kwargs["password"] = str(password)
        if server is not None:
            init_kwargs["server"] = str(server)
        if timeout is not None:
            init_kwargs["timeout"] = int(timeout)

        result = bool(mt5.initialize(**init_kwargs))
        self._connected = result
        return result

    def shutdown(self) -> None:
        """Disconnect cleanly from MetaTrader 5 IPC."""
        if self._connected and self._mt5 is not None:
            try:
                self._mt5.shutdown()
            finally:
                self._connected = False

    def _ensure_connected(self) -> None:
        if not self._connected:
            raise ConnectionError("MT5Bridge is not initialized. Call initialize() first.")

    def _select_symbol(self, symbol: str) -> None:
        """Select a symbol in Market Watch; raise informative error if missing."""
        self._ensure_connected()
        mt5 = self._get_mt5()

        selected = bool(mt5.symbol_select(symbol, True))
        if not selected:
            # Inspect available symbols from broker for helpful diagnostics
            all_symbols = mt5.symbols_get()
            avail_names = [s.name for s in all_symbols] if all_symbols else []
            matched = [s for s in avail_names if symbol.lower() in s.lower()]

            if matched:
                hint = f" Available similar symbols: {matched[:6]}"
            elif avail_names:
                hint = f" Total {len(avail_names)} symbols available from broker."
            else:
                hint = " No symbols returned from broker Market Watch."

            raise ValueError(
                f"Symbol '{symbol}' could not be selected in MetaTrader 5 Market Watch.{hint}"
            )

    def get_symbol_info(self, symbol: str) -> dict[str, Any]:
        """Extract broker contract size, point size, digits, lots, swap rates, and adverse spread."""
        self._select_symbol(symbol)
        mt5 = self._get_mt5()

        info = mt5.symbol_info(symbol)
        if info is None:
            last_err = getattr(mt5, "last_error", lambda: "Unknown")()
            raise ValueError(f"Failed to retrieve symbol_info for '{symbol}'. MT5 error: {last_err}")

        # Extract attributes handling object or dict structures
        def _get(attr: str, default: Any) -> Any:
            if isinstance(info, Mapping):
                return info.get(attr, default)
            return getattr(info, attr, default)

        contract_size = float(_get("trade_contract_size", _get("contract_size", 100000.0)))
        point = float(_get("point", 0.00001))
        digits = int(_get("digits", 5))
        min_lot = float(_get("volume_min", 0.01))
        max_lot = float(_get("volume_max", 100.0))
        lot_step = float(_get("volume_step", 0.01))
        swap_long = float(_get("swap_long", 0.0))
        swap_short = float(_get("swap_short", 0.0))
        swap_mode = int(_get("swap_mode", 0))
        spread_points = int(_get("spread", 0))
        spread_float = bool(_get("spread_float", True))
        bid = float(_get("bid", 0.0))
        ask = float(_get("ask", 0.0))
        trade_tick_value = float(_get("trade_tick_value", 0.0))
        trade_tick_size = float(_get("trade_tick_size", point))
        currency_base = str(_get("currency_base", ""))
        currency_profit = str(_get("currency_profit", ""))
        currency_margin = str(_get("currency_margin", ""))

        # Adverse spread in price units
        adverse_spread = spread_points * point

        return {
            "symbol": str(_get("name", symbol)),
            "contract_size": contract_size,
            "point": point,
            "digits": digits,
            "min_lot": min_lot,
            "max_lot": max_lot,
            "lot_step": lot_step,
            "swap_long": swap_long,
            "swap_short": swap_short,
            "swap_mode": swap_mode,
            "spread": spread_points,
            "spread_float": spread_float,
            "adverse_spread": adverse_spread,
            "bid": bid,
            "ask": ask,
            "trade_tick_value": trade_tick_value,
            "trade_tick_size": trade_tick_size,
            "currency_base": currency_base,
            "currency_profit": currency_profit,
            "currency_margin": currency_margin,
        }

    def get_historical_ohlcv(
        self,
        symbol: str,
        timeframe: str | int,
        date_from: datetime | date | str | int | float,
        date_to: datetime | date | str | int | float | None = None,
        *,
        cache: bool = True,
        cache_dir: str | Path = "data/cache",
    ) -> pl.DataFrame:
        """Query native MT5 rates, convert to canonical schema, and optionally cache to parquet.

        Schema: ['time', 'open', 'high', 'low', 'close', 'tick_volume', 'spread']
        """
        self._select_symbol(symbol)
        mt5 = self._get_mt5()

        tf_int, tf_label = resolve_timeframe(timeframe, mt5)
        dt_from = _to_datetime(date_from)
        dt_to = _to_datetime(date_to) if date_to is not None else datetime.now(timezone.utc)

        rates = mt5.copy_rates_range(symbol, tf_int, dt_from, dt_to)
        if rates is None or len(rates) == 0:
            last_err = getattr(mt5, "last_error", lambda: "Unknown")()
            raise ValueError(
                f"No rates returned for {symbol} ({tf_label}) from {dt_from} to {dt_to}. MT5 error: {last_err}"
            )

        return self._finalize_rates(rates, symbol, tf_label, cache=cache, cache_dir=cache_dir)

    def get_recent_ohlcv(
        self,
        symbol: str,
        timeframe: str | int,
        bars: int = 5000,
        *,
        cache: bool = True,
        cache_dir: str | Path = "data/cache",
    ) -> pl.DataFrame:
        """Query the most recent ``bars`` closed bars via MT5 copy_rates_from.

        Count semantics survive weekends and holidays: the terminal returns
        exactly the last ``bars`` bars it holds.
        """
        if bars <= 0:
            raise ValueError(f"bars must be a positive integer, got {bars}")

        self._select_symbol(symbol)
        mt5 = self._get_mt5()
        tf_int, tf_label = resolve_timeframe(timeframe, mt5)

        rates = mt5.copy_rates_from(symbol, tf_int, datetime.now(timezone.utc), int(bars))
        if rates is None or len(rates) == 0:
            last_err = getattr(mt5, "last_error", lambda: "Unknown")()
            raise ValueError(
                f"No rates returned for {symbol} ({tf_label}) for the last {bars} bars. MT5 error: {last_err}"
            )

        return self._finalize_rates(rates, symbol, tf_label, cache=cache, cache_dir=cache_dir)

    def _finalize_rates(
        self,
        rates: Any,
        symbol: str,
        tf_label: str,
        *,
        cache: bool,
        cache_dir: str | Path,
    ) -> pl.DataFrame:
        df = pl.DataFrame(rates)

        # Explicit Epoch Timestamp conversion: seconds since epoch -> Datetime('us')
        # Prevents local machine timezone corruption
        df = df.with_columns(
            pl.from_epoch(pl.col("time"), time_unit="s").cast(pl.Datetime("us")).alias("time"),
            pl.col("open").cast(pl.Float64),
            pl.col("high").cast(pl.Float64),
            pl.col("low").cast(pl.Float64),
            pl.col("close").cast(pl.Float64),
            pl.col("tick_volume").cast(pl.Int64),
            pl.col("spread").cast(pl.Int64),
        )

        # Select standard canonical columns
        df = df.select(CANONICAL_MT5_COLUMNS).sort("time")

        if cache:
            cache_path = Path(cache_dir) / f"{symbol}_{tf_label}.parquet"
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            df.write_parquet(cache_path)

        return df

    def get_last_tick(self, symbol: str) -> dict[str, Any] | None:
        """Extract latest live tick from Market Watch."""
        self._select_symbol(symbol)
        mt5 = self._get_mt5()

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            return None

        def _get(attr: str, default: Any) -> Any:
            if isinstance(tick, Mapping):
                return tick.get(attr, default)
            return getattr(tick, attr, default)

        raw_time = _get("time", 0)
        tick_dt = datetime.fromtimestamp(raw_time, tz=timezone.utc) if raw_time else datetime.now(timezone.utc)

        return {
            "time": tick_dt,
            "bid": float(_get("bid", 0.0)),
            "ask": float(_get("ask", 0.0)),
            "last": float(_get("last", 0.0)),
            "volume": float(_get("volume", _get("volume_real", 0.0))),
            "flags": int(_get("flags", 0)),
        }

    def get_historical_ticks(
        self,
        symbol: str,
        date_from: datetime | date | str | int | float,
        date_to: datetime | date | str | int | float | None = None,
        flags: int = -1,
    ) -> pl.DataFrame:
        """Query historical tick series via MT5 copy_ticks_range."""
        self._select_symbol(symbol)
        mt5 = self._get_mt5()

        dt_from = _to_datetime(date_from)
        dt_to = _to_datetime(date_to) if date_to is not None else datetime.now(timezone.utc)

        # MT5 COPY_TICKS_ALL = -1
        copy_flags = getattr(mt5, "COPY_TICKS_ALL", -1) if flags == -1 else flags
        ticks = mt5.copy_ticks_range(symbol, dt_from, dt_to, copy_flags)

        if ticks is None or len(ticks) == 0:
            last_err = getattr(mt5, "last_error", lambda: "Unknown")()
            raise ValueError(
                f"No ticks returned for {symbol} from {dt_from} to {dt_to}. MT5 error: {last_err}"
            )

        df = pl.DataFrame(ticks)

        # Epoch time conversion with millisecond precision support if time_msc is present
        if "time_msc" in df.columns:
            df = df.with_columns(
                pl.from_epoch(pl.col("time_msc"), time_unit="ms").cast(pl.Datetime("us")).alias("time")
            )
        else:
            df = df.with_columns(
                pl.from_epoch(pl.col("time"), time_unit="s").cast(pl.Datetime("us")).alias("time")
            )

        return df.sort("time")

    def __enter__(self) -> MT5Bridge:
        self.initialize()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.shutdown()
