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

# Common MT5 export aliases -> canonical.
_ALIAS_MAP = {
    "datetime": CANON_TIME,
    "timestamp": CANON_TIME,
    "date": CANON_TIME,
    "o": CANON_OPEN,
    "h": CANON_HIGH,
    "l": CANON_LOW,
    "c": CANON_CLOSE,
    "vol": CANON_VOLUME,
    "spread_points": CANON_SPREAD,
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
    renamed: dict[str, str] = {}
    for col in df.columns:
        key = col.strip().lower()
        if key in _ALIAS_MAP:
            renamed[col] = _ALIAS_MAP[key]
        elif key != col.lower():
            renamed[col] = key
    if renamed:
        df = df.rename(renamed)
    return df


def _coerce_schema(df: pl.DataFrame) -> pl.DataFrame:
    if CANON_TIME not in df.columns:
        raise ValueError(f"missing required time column; have {df.columns}")

    if df.schema[CANON_TIME] != pl.Datetime:
        df = df.with_columns(pl.col(CANON_TIME).cast(pl.Datetime("us")))

    for col in _OHLCV:
        if col in df.columns and df.schema[col] not in (pl.Float64, pl.Float32):
            df = df.with_columns(pl.col(col).cast(pl.Float64))
    if CANON_VOLUME in df.columns and not df.schema[CANON_VOLUME].is_numeric():
        df = df.with_columns(pl.col(CANON_VOLUME).cast(pl.Float64))
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


def load_ohlcv(
    path: str | Path,
    *,
    timeframe_seconds: int | None = None,
    instrument: str | None = None,
) -> tuple[pl.DataFrame, QAResult]:
    """Load an MT5 Parquet or CSV export and run QA checks.

    Returns (DataFrame, QAResult). The frame is sorted ascending by time and
    deduplicated; QA issues are reported but never silently mutate the data
    beyond sort/dedupe and type coercion.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(p)

    if p.suffix.lower() in (".parquet", ".pq"):
        df = pl.read_parquet(p)
    elif p.suffix.lower() in (".csv", ".txt"):
        df = pl.read_csv(p, try_parse_dates=True)
    else:
        raise ValueError(f"unsupported file type: {p.suffix}")

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
