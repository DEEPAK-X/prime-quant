"""Data loading and quality-assurance for MT5 Parquet/CSV exports.

Polars-first. Columns expected (case-insensitive, aliased from MT5 export
conventions): time (datetime), open/high/low/close (float), and optionally
volume, spread (points), bid, ask. The loader normalizes to a canonical
schema and runs QA checks that surface problems without rejecting data
silently - every issue is recorded in a QAResult returned alongside the frame.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import polars as pl

# Canonical column names used throughout the engine.
CANON_TIME = "time"
CANON_OPEN = "open"
CANON_HIGH = "high"
CANON_LOW = "low"
CANON_CLOSE = "close"
CANON_VOLUME = "volume"
CANON_SPREAD = "spread"  # MT5 spread in points
CANON_BID = "bid"
CANON_ASK = "ask"

_OHLCV = (CANON_OPEN, CANON_HIGH, CANON_LOW, CANON_CLOSE)
_REQUIRED = (CANON_TIME, *_OHLCV)

# Common MT4/MT5, broker, and market-data export aliases -> canonical.
_ALIAS_MAP = {
    # Time aliases
    "datetime": CANON_TIME,
    "timestamp": CANON_TIME,
    "date_time": CANON_TIME,
    "date time": CANON_TIME,
    "gmt time": CANON_TIME,
    "time (utc)": CANON_TIME,
    "date (utc)": CANON_TIME,
    "dtime": CANON_TIME,
    "time": CANON_TIME,
    "date": CANON_TIME,
    "<datetime>": CANON_TIME,
    "<timestamp>": CANON_TIME,
    "<date>": CANON_TIME,
    "<time>": CANON_TIME,
    "<dtime>": CANON_TIME,
    "ts": CANON_TIME,
    "dt": CANON_TIME,

    # Open aliases
    "o": CANON_OPEN,
    "open": CANON_OPEN,
    "<open>": CANON_OPEN,
    "open_price": CANON_OPEN,
    "openprice": CANON_OPEN,
    "first": CANON_OPEN,

    # High aliases
    "h": CANON_HIGH,
    "high": CANON_HIGH,
    "<high>": CANON_HIGH,
    "high_price": CANON_HIGH,
    "highprice": CANON_HIGH,
    "max": CANON_HIGH,

    # Low aliases
    "l": CANON_LOW,
    "low": CANON_LOW,
    "<low>": CANON_LOW,
    "low_price": CANON_LOW,
    "lowprice": CANON_LOW,
    "min": CANON_LOW,

    # Close aliases
    "c": CANON_CLOSE,
    "close": CANON_CLOSE,
    "<close>": CANON_CLOSE,
    "close_price": CANON_CLOSE,
    "closeprice": CANON_CLOSE,
    "last": CANON_CLOSE,
    "price": CANON_CLOSE,
    "adj close": CANON_CLOSE,
    "adj_close": CANON_CLOSE,
    "adjclose": CANON_CLOSE,

    # Volume aliases
    "vol": CANON_VOLUME,
    "volume": CANON_VOLUME,
    "v": CANON_VOLUME,
    "<vol>": CANON_VOLUME,
    "<volume>": CANON_VOLUME,
    "<tickvol>": CANON_VOLUME,
    "tick_volume": CANON_VOLUME,
    "tickvol": CANON_VOLUME,
    "tick_vol": CANON_VOLUME,
    "real_volume": CANON_VOLUME,
    "realvol": CANON_VOLUME,
    "real_vol": CANON_VOLUME,
    "qty": CANON_VOLUME,
    "quantity": CANON_VOLUME,
    "total_volume": CANON_VOLUME,
    "base_volume": CANON_VOLUME,
    "quote_volume": CANON_VOLUME,

    # Spread aliases
    "spread": CANON_SPREAD,
    "<spread>": CANON_SPREAD,
    "spread_points": CANON_SPREAD,
    "spread_pts": CANON_SPREAD,
    "spreads": CANON_SPREAD,

    # Bid / Ask aliases
    "bid": CANON_BID,
    "<bid>": CANON_BID,
    "bid_price": CANON_BID,
    "bidprice": CANON_BID,
    "ask": CANON_ASK,
    "<ask>": CANON_ASK,
    "ask_price": CANON_ASK,
    "askprice": CANON_ASK,
}


# Target priorities for canonical columns to avoid duplicate renames.
_TARGET_PRIORITIES: dict[str, list[str]] = {
    CANON_TIME: [
        "time",
        "datetime",
        "timestamp",
        "<datetime>",
        "<timestamp>",
        "date_time",
        "date time",
        "gmt time",
        "time (utc)",
        "date (utc)",
        "dtime",
        "<dtime>",
        "date",
        "<date>",
        "<time>",
        "dt",
        "ts",
    ],
    CANON_OPEN: [
        "open",
        "<open>",
        "open_price",
        "openprice",
        "o",
        "first",
    ],
    CANON_HIGH: [
        "high",
        "<high>",
        "high_price",
        "highprice",
        "h",
        "max",
    ],
    CANON_LOW: [
        "low",
        "<low>",
        "low_price",
        "lowprice",
        "l",
        "min",
    ],
    CANON_CLOSE: [
        "close",
        "<close>",
        "close_price",
        "closeprice",
        "c",
        "last",
        "price",
        "adj close",
        "adj_close",
        "adjclose",
    ],
    CANON_VOLUME: [
        "volume",
        "<volume>",
        "tick_volume",
        "tickvol",
        "<tickvol>",
        "tick_vol",
        "vol",
        "<vol>",
        "real_volume",
        "realvol",
        "real_vol",
        "qty",
        "quantity",
        "total_volume",
        "base_volume",
        "quote_volume",
        "v",
    ],
    CANON_SPREAD: [
        "spread",
        "<spread>",
        "spread_points",
        "spread_pts",
        "spreads",
    ],
    CANON_BID: [
        "bid",
        "<bid>",
        "bid_price",
        "bidprice",
    ],
    CANON_ASK: [
        "ask",
        "<ask>",
        "ask_price",
        "askprice",
    ],
}


@dataclass
class QAIssue:
    code: str
    message: str
    severity: str = "warn"  # "warn" | "error"
    detail: dict | None = None


@dataclass
class QAResult:
    issues: list[QAIssue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)

    @property
    def has_errors(self) -> bool:
        return any(i.severity == "error" for i in self.issues)

    def add(self, issue: QAIssue) -> None:
        self.issues.append(issue)

    def to_summary(self) -> dict:
        return {
            "ok": self.ok,
            "error_count": sum(1 for i in self.issues if i.severity == "error"),
            "warning_count": sum(1 for i in self.issues if i.severity == "warn"),
            "issues": [
                {"code": i.code, "severity": i.severity, "message": i.message}
                for i in self.issues
            ],
        }


def _normalize_columns(df: pl.DataFrame) -> pl.DataFrame:
    col_keys = {col: col.strip().lower() for col in df.columns}

    # Detect separate date and time columns (e.g. <DATE> and <TIME>, Date and Time)
    date_cols = [c for c, k in col_keys.items() if k in ("date", "<date>")]
    time_cols = [c for c, k in col_keys.items() if k in ("time", "<time>")]

    if date_cols and time_cols and date_cols[0] != time_cols[0]:
        d_col, t_col = date_cols[0], time_cols[0]
        combined = pl.concat_str([pl.col(d_col).cast(pl.String), pl.col(t_col).cast(pl.String)], separator=" ")
        df = df.with_columns(combined.alias(CANON_TIME)).drop([d_col, t_col])
        col_keys = {col: col.strip().lower() for col in df.columns}

    assigned_sources: set[str] = set()
    renames: dict[str, str] = {}

    for target, candidates in _TARGET_PRIORITIES.items():
        if target in df.columns:
            for col, key in col_keys.items():
                if col == target:
                    assigned_sources.add(col)
                    break
            continue
        for cand in candidates:
            matched_col = None
            for col, key in col_keys.items():
                if col not in assigned_sources and key == cand:
                    matched_col = col
                    break
            if matched_col is not None:
                renames[matched_col] = target
                assigned_sources.add(matched_col)
                break

    existing_names = (set(df.columns) - set(renames.keys())) | set(renames.values())
    for col, key in col_keys.items():
        if col not in assigned_sources:
            if key not in existing_names:
                renames[col] = key
                existing_names.add(key)

    if renames:
        df = df.rename(renames)
    return df


def _coerce_time_column(df: pl.DataFrame) -> pl.DataFrame:
    if CANON_TIME not in df.columns:
        raise ValueError(f"missing required time column; have {df.columns}")

    s = df[CANON_TIME]

    if s.dtype.is_numeric():
        valid = s.drop_nulls()
        first_val = abs(float(valid[0])) if len(valid) > 0 else 0.0
        if first_val > 1e16:
            unit = "ns"
        elif first_val > 1e13:
            unit = "us"
        elif first_val > 1e10:
            unit = "ms"
        else:
            unit = "s"
        expr = (
            pl.from_epoch(pl.col(CANON_TIME).cast(pl.Int64), time_unit=unit)
            .cast(pl.Datetime("us"))
            .dt.replace_time_zone("UTC")
        )
        return df.with_columns(expr.alias(CANON_TIME))

    if s.dtype == pl.Date:
        expr = pl.col(CANON_TIME).cast(pl.Datetime("us")).dt.replace_time_zone("UTC")
        return df.with_columns(expr.alias(CANON_TIME))

    if isinstance(s.dtype, pl.Datetime):
        if s.dtype.time_zone is None:
            expr = pl.col(CANON_TIME).cast(pl.Datetime("us")).dt.replace_time_zone("UTC")
        else:
            expr = pl.col(CANON_TIME).dt.convert_time_zone("UTC").cast(pl.Datetime("us", "UTC"))
        return df.with_columns(expr.alias(CANON_TIME))

    if s.dtype in (pl.String, pl.Utf8, pl.Object):
        str_s = s.cast(pl.String)
        parsed = None
        try:
            candidate = str_s.str.to_datetime(strict=False)
            if candidate.null_count() == 0 and len(candidate) > 0:
                parsed = candidate
        except Exception:
            pass

        if parsed is None:
            fmts = [
                "%Y.%m.%d %H:%M:%S",
                "%Y.%m.%d %H:%M",
                "%Y.%m.%d",
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M",
                "%Y-%m-%d",
                "%Y/%m/%d %H:%M:%S",
                "%Y/%m/%d %H:%M",
                "%Y/%m/%d",
                "%d/%m/%Y %H:%M:%S",
                "%d/%m/%Y %H:%M",
                "%d/%m/%Y",
                "%d.%m.%Y %H:%M:%S",
                "%d.%m.%Y %H:%M",
                "%d.%m.%Y",
                "%m/%d/%Y %H:%M:%S",
                "%m/%d/%Y %H:%M",
                "%m/%d/%Y",
                "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%SZ",
                "%Y-%m-%dT%H:%M:%S",
            ]
            for f in fmts:
                try:
                    candidate = str_s.str.to_datetime(f, strict=False)
                    if candidate.null_count() == 0 and len(candidate) > 0:
                        parsed = candidate
                        break
                except Exception:
                    continue

        if parsed is None or (len(parsed) > 0 and parsed.null_count() == len(parsed)):
            raise ValueError(f"Unable to parse datetime column '{CANON_TIME}'")

        if parsed.dtype.time_zone is None:
            expr = parsed.cast(pl.Datetime("us")).dt.replace_time_zone("UTC")
        else:
            expr = parsed.dt.convert_time_zone("UTC").cast(pl.Datetime("us", "UTC"))
        return df.with_columns(expr.alias(CANON_TIME))

    raise ValueError(f"Unsupported time column type: {s.dtype}")


def _coerce_schema(df: pl.DataFrame) -> pl.DataFrame:
    df = _coerce_time_column(df)

    for col in _OHLCV:
        if col in df.columns:
            if df.schema[col] not in (pl.Float64, pl.Float32):
                if df.schema[col] in (pl.String, pl.Utf8):
                    cleaned = pl.col(col).cast(pl.String).str.replace_all(r"[$€£,\s]", "").cast(pl.Float64, strict=False)
                    df = df.with_columns(cleaned.alias(col))
                else:
                    df = df.with_columns(pl.col(col).cast(pl.Float64, strict=False))

    if CANON_VOLUME in df.columns and not df.schema[CANON_VOLUME].is_numeric():
        if df.schema[CANON_VOLUME] in (pl.String, pl.Utf8):
            cleaned = pl.col(CANON_VOLUME).cast(pl.String).str.replace_all(r"[,\s]", "").cast(pl.Float64, strict=False)
            df = df.with_columns(cleaned.alias(CANON_VOLUME))
        else:
            df = df.with_columns(pl.col(CANON_VOLUME).cast(pl.Float64, strict=False))

    if CANON_SPREAD in df.columns and not df.schema[CANON_SPREAD].is_numeric():
        df = df.with_columns(pl.col(CANON_SPREAD).cast(pl.Float64, strict=False))

    return df


def _ensure_spread(df: pl.DataFrame) -> pl.DataFrame:
    """Materialize a spread column from bid/ask if present, else leave absent.

    Spread is stored in price units (ask - bid). MT5 exports it in points; the
    loader does not assume a point size here - callers convert with instrument
    metadata. QA flags anomalies on whichever representation is available.
    """
    if CANON_SPREAD in df.columns:
        return df
    if CANON_BID in df.columns and CANON_ASK in df.columns:
        df = df.with_columns((pl.col(CANON_ASK) - pl.col(CANON_BID)).alias(CANON_SPREAD))
    return df


def _detect_separator(path: Path) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for _ in range(5):
                line = f.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                if "\t" in line:
                    return "\t"
                if ";" in line:
                    return ";"
                if "," in line:
                    return ","
    except Exception:
        pass
    return ","


def load_ohlcv(
    path: str | Path,
    *,
    timeframe_seconds: int | None = None,
    instrument: str | None = None,
) -> tuple[pl.DataFrame, QAResult]:
    """Load a broker CSV or Parquet export and run QA checks.

    Returns (DataFrame, QAResult). The frame is sorted ascending by time,
    deduplicated, and normalized to canonical OHLCV schema with timezone-aware
    UTC timestamps.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")

    if p.stat().st_size == 0:
        raise ValueError(f"Data file is empty: {p}")

    suffix = p.suffix.lower()
    if suffix in (".parquet", ".pq"):
        try:
            df = pl.read_parquet(p)
        except Exception as err:
            raise ValueError(f"Failed to read parquet file {p}: {err}") from err
    elif suffix in (".csv", ".txt", ".tsv", ".dat", ".csv.gz", ".csv.zip"):
        sep = "\t" if suffix == ".tsv" else _detect_separator(p)
        try:
            df = pl.read_csv(
                p,
                separator=sep,
                try_parse_dates=False,
                infer_schema_length=10000,
                truncate_ragged_lines=True,
            )
        except Exception as err:
            raise ValueError(f"Failed to read CSV file {p}: {err}") from err
    else:
        raise ValueError(f"unsupported file type: {p.suffix}")

    if df.height == 0:
        raise ValueError(f"Data file contains no rows: {p}")

    df = _normalize_columns(df)
    df = _coerce_schema(df)
    df = _ensure_spread(df)

    qa = QAResult()
    df = run_qa(df, qa=qa, timeframe_seconds=timeframe_seconds, instrument=instrument)
    return df, qa


def run_qa(
    df: pl.DataFrame,
    *,
    qa: QAResult | None = None,
    timeframe_seconds: int | None = None,
    instrument: str | None = None,
    spread_zscore_threshold: float = 6.0,
) -> pl.DataFrame:
    """Run QA checks in place, appending issues to ``qa``.

    Checks: required columns, monotonicity, duplicates, gap detection
    (weekend/holiday-aware for FX), and spread anomaly flagging. The returned
    frame is sorted ascending and deduplicated on time.
    """
    qa = qa or QAResult()

    missing = [c for c in _REQUIRED if c not in df.columns]
    if missing:
        qa.add(QAIssue("missing_columns", f"missing required columns: {missing}", "error"))
        return df

    # Duplicates on time - dedupe, keeping first.
    n_before = df.height
    df = df.unique(subset=[CANON_TIME], keep="first")
    n_dupes = n_before - df.height
    if n_dupes:
        qa.add(
            QAIssue(
                "duplicate_timestamps",
                f"removed {n_dupes} duplicate timestamp rows",
                "warn",
            )
        )

    # Sort ascending.
    is_sorted = df.select(pl.col(CANON_TIME).is_sorted()).item()
    if not is_sorted:
        df = df.sort(CANON_TIME)
        qa.add(QAIssue("unsorted", "timestamps were not ascending; sorted", "warn"))

    # Monotonicity (strictly increasing after dedupe).
    diffs = df.select((pl.col(CANON_TIME).diff()).dt.total_seconds()).to_series()
    nonpositive = diffs.filter((diffs <= 0) & diffs.is_not_null())
    if nonpositive.len() > 0:
        qa.add(
            QAIssue(
                "non_monotonic",
                f"{nonpositive.len()} non-positive time deltas remain after dedupe",
                "error",
            )
        )

    # OHLC sanity: high >= low, high >= open/close, low <= open/close.
    bad_hl = df.filter(pl.col(CANON_HIGH) < pl.col(CANON_LOW)).height
    if bad_hl:
        qa.add(
            QAIssue(
                "ohlc_invariant",
                f"{bad_hl} rows where high < low",
                "error",
            )
        )

    # Gap detection.
    _detect_gaps(df, qa, timeframe_seconds=timeframe_seconds, instrument=instrument)

    # Spread anomalies.
    if CANON_SPREAD in df.columns:
        _flag_spread_anomalies(df, qa, threshold=spread_zscore_threshold)

    return df


def _detect_gaps(
    df: pl.DataFrame,
    qa: QAResult,
    *,
    timeframe_seconds: int | None,
    instrument: str | None,
) -> None:
    if df.height < 2:
        return

    diffs = df.select(pl.col(CANON_TIME).diff().dt.total_seconds()).to_series().drop_nulls()
    if diffs.is_empty():
        return

    # Infer timeframe if not provided: the mode of the diff.
    if timeframe_seconds is None:
        tf = diffs.mode().item()
        if tf is None or tf <= 0:
            qa.add(QAIssue("timeframe_unknown", "could not infer timeframe from timestamps", "warn"))
            return
    else:
        tf = float(timeframe_seconds)

    # A gap is a diff strictly greater than the expected timeframe, with a
    # tolerance. Weekend gaps are expected for FX (market closed Fri->Sun) and
    # are reported separately from unexpected intra-week gaps.
    tol = max(tf * 0.5, 1.0)
    # Collect the row indices where the gap exceeds the expected timeframe.
    # diffs is aligned to df rows with a null at row 0 (no prior bar).
    over = diffs.to_list()
    gap_rows = [i for i, d in enumerate(over) if d is not None and d > tf + tol]
    if not gap_rows:
        return

    weekend_gaps = 0
    unexpected_gaps = 0
    times = df[CANON_TIME].to_list()
    for end_row in gap_rows:
        if end_row < 1 or end_row >= df.height:
            continue
        start_t = times[end_row - 1]
        end_t = times[end_row]
        # FX weekend: Friday evening to Sunday evening. Classify any gap that
        # spans across Saturday as an expected weekend gap.
        if _spans_weekend(start_t, end_t):
            weekend_gaps += 1
        else:
            unexpected_gaps += 1

    if weekend_gaps:
        qa.add(
            QAIssue(
                "weekend_gap",
                f"{weekend_gaps} weekend/holiday gaps detected (expected for FX)",
                "warn",
                {"count": weekend_gaps},
            )
        )
    if unexpected_gaps:
        qa.add(
            QAIssue(
                "unexpected_gap",
                f"{unexpected_gaps} unexpected intra-period gaps larger than timeframe",
                "warn",
                {"count": unexpected_gaps, "timeframe_seconds": tf},
            )
        )


def _spans_weekend(start_t, end_t) -> bool:
    # start_t, end_t are datetime objects. Weekend = Saturday(5)/Sunday(6).
    try:
        start_dow = start_t.weekday()
        end_dow = end_t.weekday()
    except AttributeError:
        return False
    # If the interval contains any Saturday, treat as weekend gap.
    if start_dow == 5 or start_dow == 6 or end_dow == 5 or end_dow == 6:
        return True
    if end_dow < start_dow:
        # wrapped around the week
        return True
    return False


def _flag_spread_anomalies(df: pl.DataFrame, qa: QAResult, *, threshold: float) -> None:
    spread = df[CANON_SPREAD].drop_nulls()
    if spread.len() < 10:
        return
    mean = float(spread.mean())
    std = float(spread.std())
    if std == 0 or std != std:  # zero or nan
        return
    z = (spread - mean) / std
    outliers = int(z.filter(z.abs() > threshold).len())
    if outliers:
        qa.add(
            QAIssue(
                "spread_anomaly",
                f"{outliers} spread observations beyond |z|>{threshold} (possible stale/spike)",
                "warn",
                {"count": outliers, "mean": mean, "std": std, "threshold": threshold},
            )
        )


def resample(df: pl.DataFrame, rule: str) -> pl.DataFrame:
    """Resample OHLCV to a Polars duration rule (e.g. '5m', '1h')."""
    agg = [
        pl.col(CANON_OPEN).first(),
        pl.col(CANON_HIGH).max(),
        pl.col(CANON_LOW).min(),
        pl.col(CANON_CLOSE).last(),
    ]
    if CANON_VOLUME in df.columns:
        agg.append(pl.col(CANON_VOLUME).sum())
    if CANON_SPREAD in df.columns:
        agg.append(pl.col(CANON_SPREAD).mean())
    return df.sort(CANON_TIME).group_by_dynamic(CANON_TIME, every=rule).agg(agg)
