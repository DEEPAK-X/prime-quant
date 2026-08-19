"""Live MT5 market-data fetch with context compression.

Pulls the most recent OHLCV bars from the local MetaTrader 5 terminal via
``primequant.data.mt5.MT5Bridge``, runs the engine's QA checks, and returns
**only** a compact JSON summary card. The raw frame never crosses the context
boundary: it is bound in the kernel scope as both ``df`` (so ``run_backtest``
picks it up when ``data`` is omitted) and ``_last_df``.

Requires the ``MetaTrader5`` Python package, a running MT5 terminal, and
Windows. Optional ``PRIME_QUANT_MT5_*`` environment variables mirror the
``mt5.initialize`` arguments for non-default terminals or explicit logins.
"""

from __future__ import annotations

import os
from typing import Any

from .runner import (
    QuantInputError,
    QuantUnavailableError,
    _bind_last,
    _caller_namespace,
    _error_card,
    card_to_json,
)

_LAST_DF = "_last_df"
DEFAULT_BARS = 5000

_TRUTHY = ("1", "true", "yes")


def _env_int(name: str) -> int:
    raw = os.environ.get(name)
    if raw is None:
        raise QuantInputError(f"{name} must be an integer, got None")
    try:
        return int(raw)
    except ValueError as exc:
        raise QuantInputError(f"{name} must be an integer, got {raw!r}") from exc


def _initialize_kwargs() -> dict[str, Any]:
    """Build mt5.initialize kwargs from PRIME_QUANT_MT5_* env overrides."""
    kwargs: dict[str, Any] = {}
    if path := os.environ.get("PRIME_QUANT_MT5_PATH"):
        kwargs["path"] = path
    if os.environ.get("PRIME_QUANT_MT5_PORTABLE", "").lower() in _TRUTHY:
        kwargs["portable"] = True
    if os.environ.get("PRIME_QUANT_MT5_LOGIN"):
        kwargs["login"] = _env_int("PRIME_QUANT_MT5_LOGIN")
    if password := os.environ.get("PRIME_QUANT_MT5_PASSWORD"):
        kwargs["password"] = password
    if server := os.environ.get("PRIME_QUANT_MT5_SERVER"):
        kwargs["server"] = server
    if os.environ.get("PRIME_QUANT_MT5_TIMEOUT"):
        kwargs["timeout"] = _env_int("PRIME_QUANT_MT5_TIMEOUT")
    return kwargs


def _qa_card_summary(qa: Any) -> dict[str, Any]:
    summary = qa.to_summary()
    return {
        "ok": summary.get("ok"),
        "error_count": summary.get("error_count"),
        "warning_count": summary.get("warning_count"),
    }


async def load_data(
    path: str | os.PathLike[str],
    *,
    symbol: str | None = None,
    timeframe: str | None = None,
    timeframe_seconds: int | None = None,
    namespace: dict[str, Any] | None = None,
) -> str:
    """Load an OHLCV CSV or Parquet file from disk and return a compact JSON card.

    - ``path``: path to CSV or Parquet file.
    - ``symbol``: optional symbol label to record in the card.
    - ``timeframe``: optional timeframe label (e.g. "M5", "H1").
    - ``namespace``: where to bind ``df`` / ``_last_df`` (defaults to caller's scope).
    """
    ns = namespace if namespace is not None else _caller_namespace()
    try:
        try:
            from primequant.data.loader import load_ohlcv
        except Exception as exc:
            raise QuantUnavailableError(
                "primequant is not installed in this kernel environment; "
                "install the prime-quant package (polars + numpy) and restart the kernel"
            ) from exc

        file_path = str(path)
        df, qa = load_ohlcv(file_path, timeframe_seconds=timeframe_seconds)

        sym = symbol or os.path.splitext(os.path.basename(file_path))[0]
        card: dict[str, Any] = {
            "status": "success",
            "source": file_path,
            "symbol": sym,
            "rows": df.height,
            "range": [str(df["time"].min()), str(df["time"].max())],
            "qa": _qa_card_summary(qa),
        }
        if timeframe:
            card["timeframe"] = timeframe

        ns["df"] = df
        _bind_last(ns, **{_LAST_DF: df})
        return card_to_json(card)
    except Exception as exc:  # noqa: BLE001 - failures return an error card
        return _error_card(exc)


async def fetch_data(
    symbol: str,
    timeframe: str = "M5",
    bars: int = DEFAULT_BARS,
    *,
    namespace: dict[str, Any] | None = None,
    cache: bool = True,
    cache_dir: str = "data/cache",
    mt5_module: Any = None,
) -> str:
    """Fetch live OHLCV bars from MetaTrader 5 and return a compact JSON card.

    - ``symbol``: broker symbol as shown in Market Watch (e.g. ``"EURUSD"``) or a file path.
    - ``timeframe``: ``M1``..``MN1`` style label (e.g. ``"M5"``, ``"H1"``).
    - ``bars``: number of most-recent closed bars to pull.
    - ``namespace``: where to bind ``df`` / ``_last_df`` (defaults to the
      caller's kernel namespace).
    - ``cache`` / ``cache_dir``: parquet cache of the pulled frame.
    - ``mt5_module``: injectable MetaTrader5 module for tests.

    The card carries only symbol, timeframe, row count, time range, QA flag
    counts, and the cache file name. A QA error keeps ``status: "success"``
    with ``qa.ok=false``; inspect ``_last_df`` from the kernel before trusting
    the data.
    """
    ns = namespace if namespace is not None else _caller_namespace()

    # If symbol is an existing file or has a data file extension, load directly from file
    if os.path.isfile(symbol) or any(symbol.lower().endswith(ext) for ext in (".csv", ".parquet", ".pq", ".tsv", ".txt")):
        return await load_data(symbol, timeframe=timeframe, namespace=ns)

    bridge = None
    try:
        try:
            from primequant.data.loader import QAResult, load_ohlcv, run_qa
            from primequant.data.mt5 import MT5Bridge, resolve_timeframe
        except Exception as exc:
            raise QuantUnavailableError(
                "primequant is not installed in this kernel environment; "
                "install the prime-quant package (polars + numpy) and restart the kernel"
            ) from exc

        if mt5_module is None:
            try:
                import MetaTrader5 as mt5_module_default
            except ImportError:
                mt5_module_default = None
            mt5_module = mt5_module_default

        _, tf_label = resolve_timeframe(timeframe)
        kwargs = _initialize_kwargs()
        bridge = MT5Bridge(mt5_module)
        if not bridge.initialize(**kwargs):
            raise ConnectionError(
                "mt5.initialize failed; start the MetaTrader 5 terminal and log in, "
                "or set PRIME_QUANT_MT5_PATH/LOGIN/PASSWORD/SERVER, or load from a file using load_data(path)"
            )

        df = bridge.get_recent_ohlcv(symbol, timeframe, int(bars), cache=cache, cache_dir=cache_dir)
        if "tick_volume" in df.columns:
            df = df.rename({"tick_volume": "volume"})

        qa = QAResult()
        df = run_qa(df, qa=qa)

        card: dict[str, Any] = {
            "status": "success",
            "symbol": symbol,
            "timeframe": tf_label,
            "rows": df.height,
            "range": [str(df["time"].min()), str(df["time"].max())],
            "qa": _qa_card_summary(qa),
            "cache": f"{symbol}_{tf_label}.parquet" if cache else None,
        }
        ns["df"] = df
        _bind_last(ns, **{_LAST_DF: df})
        return card_to_json(card)
    except Exception as exc:  # noqa: BLE001 - failures return an error card
        return _error_card(exc)
    finally:
        if bridge is not None:
            bridge.shutdown()


__all__ = ["DEFAULT_BARS", "fetch_data", "load_data"]
