"""Tests for the Polars-first data loader and QA checks."""

from __future__ import annotations

from datetime import datetime, timedelta

import polars as pl
import pytest

from primequant.data.loader import (
    CANON_CLOSE,
    CANON_HIGH,
    CANON_LOW,
    CANON_OPEN,
    CANON_SPREAD,
    CANON_TIME,
    CANON_VOLUME,
    load_ohlcv,
    resample,
    run_qa,
    QAResult,
)
from tests._fxdata import synthetic_fx


def test_synthetic_fx_has_canonical_schema():
    df = synthetic_fx(n_bars=50)
    for col in (CANON_TIME, CANON_OPEN, CANON_HIGH, CANON_LOW, CANON_CLOSE, CANON_SPREAD):
        assert col in df.columns
    assert df.height == 50
    assert df[CANON_TIME].is_sorted()


def test_qa_clean_data_no_errors():
    df = synthetic_fx(n_bars=200)
    qa = QAResult()
    run_qa(df, qa=qa)
    assert not qa.has_errors, [i.message for i in qa.issues if i.severity == "error"]


def test_qa_detects_non_monotonic():
    df = synthetic_fx(n_bars=100)
    # Swap two rows to break monotonicity.
    bad = df.with_row_index().sort("index", descending=True).drop("index")
    qa = QAResult()
    run_qa(bad, qa=qa)
    # After sort+dedupe it should be clean, so no error; verify it sorted.
    assert bad[CANON_TIME].is_sorted() is False
    out = run_qa(bad, qa=qa)
    assert out[CANON_TIME].is_sorted()


def test_qa_detects_duplicate_timestamps():
    df = synthetic_fx(n_bars=100)
    dup = pl.concat([df, df.head(5)])
    qa = QAResult()
    out = run_qa(dup, qa=qa)
    assert out.height == df.height
    assert any(i.code == "duplicate_timestamps" for i in qa.issues)


def test_qa_detects_ohlc_invariant_violation():
    df = synthetic_fx(n_bars=100)
    # Force high < low on a few rows.
    bad = df.with_columns(
        pl.when(pl.arange(0, pl.len()) < 5)
        .then(pl.col(CANON_LOW) * 10)
        .otherwise(pl.col(CANON_LOW))
        .alias(CANON_LOW)
    )
    qa = QAResult()
    run_qa(bad, qa=qa)
    assert any(i.code == "ohlc_invariant" and i.severity == "error" for i in qa.issues)
    assert qa.has_errors


def test_qa_detects_weekend_gap():
    # Build a series with a jump from Friday to Monday (weekend gap).
    fri = datetime(2024, 1, 5, 22)  # Friday evening
    mon = datetime(2024, 1, 8, 0)  # Monday
    times = [fri + timedelta(hours=i) for i in range(3)] + [mon + timedelta(hours=i) for i in range(3)]
    df = pl.DataFrame(
        {
            CANON_TIME: times,
            CANON_OPEN: [1.1] * 6,
            CANON_HIGH: [1.11] * 6,
            CANON_LOW: [1.09] * 6,
            CANON_CLOSE: [1.1] * 6,
        }
    )
    qa = QAResult()
    run_qa(df, qa=qa, timeframe_seconds=3600)
    assert any(i.code == "weekend_gap" for i in qa.issues)


def test_qa_flags_spread_anomaly():
    df = synthetic_fx(n_bars=200)
    # Inject a wild spread outlier.
    bad = df.with_columns(
        pl.when(pl.arange(0, pl.len()) == 100)
        .then(50000)
        .otherwise(pl.col(CANON_SPREAD))
        .alias(CANON_SPREAD)
    )
    qa = QAResult()
    run_qa(bad, qa=qa, spread_zscore_threshold=4.0)
    assert any(i.code == "spread_anomaly" for i in qa.issues)


def test_qa_to_summary_shape():
    qa = QAResult()
    s = qa.to_summary()
    assert s["ok"] is True
    assert s["error_count"] == 0


def test_load_ohlcv_csv_roundtrip(tmp_path):
    df = synthetic_fx(n_bars=80)
    p = tmp_path / "eurusd.csv"
    df.write_csv(p)
    loaded, qa = load_ohlcv(p, timeframe_seconds=3600)
    assert loaded.height == 80
    assert CANON_TIME in loaded.columns
    assert loaded[CANON_TIME].is_sorted()
    assert loaded.schema[CANON_TIME].time_zone == "UTC"


def test_load_ohlcv_parquet_roundtrip(tmp_path):
    df = synthetic_fx(n_bars=80)
    p = tmp_path / "eurusd.parquet"
    df.write_parquet(p)
    loaded, qa = load_ohlcv(p, timeframe_seconds=3600)
    assert loaded.height == 80
    assert not qa.has_errors
    assert loaded.schema[CANON_TIME].time_zone == "UTC"


def test_load_ohlcv_unsupported_type(tmp_path):
    p = tmp_path / "x.json"
    p.write_text("[]")
    with pytest.raises(ValueError, match="unsupported file type"):
        load_ohlcv(p)


def test_load_ohlcv_empty_file_raises(tmp_path):
    p = tmp_path / "empty.csv"
    p.write_text("")
    with pytest.raises(ValueError, match="empty"):
        load_ohlcv(p)


def test_load_ohlcv_nonexistent_file_raises():
    with pytest.raises(FileNotFoundError):
        load_ohlcv("nonexistent_path_to_file.csv")


def test_load_ohlcv_mt5_tab_separated_date_time(tmp_path):
    content = (
        "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n"
        "2024.01.02\t00:00:00\t1.1000\t1.1050\t1.0950\t1.1020\t100\t0\t10\n"
        "2024.01.02\t01:00:00\t1.1020\t1.1080\t1.1010\t1.1070\t150\t0\t10\n"
        "2024.01.02\t02:00:00\t1.1070\t1.1090\t1.1040\t1.1050\t120\t0\t10\n"
    )
    p = tmp_path / "mt5_export.csv"
    p.write_text(content)
    df, qa = load_ohlcv(p, timeframe_seconds=3600)
    assert df.height == 3
    assert set(df.columns) >= {CANON_TIME, CANON_OPEN, CANON_HIGH, CANON_LOW, CANON_CLOSE, CANON_VOLUME, CANON_SPREAD}
    assert df.schema[CANON_TIME].time_zone == "UTC"
    assert not qa.has_errors
    assert df[CANON_OPEN].to_list() == [1.1000, 1.1020, 1.1070]


def test_load_ohlcv_yahoo_finance_variant(tmp_path):
    content = (
        "Date,Open,High,Low,Close,Adj Close,Volume\n"
        "2024-01-02,1.1000,1.1050,1.0950,1.1020,1.1020,1000\n"
        "2024-01-03,1.1020,1.1080,1.1010,1.1070,1.1070,1500\n"
    )
    p = tmp_path / "yahoo.csv"
    p.write_text(content)
    df, qa = load_ohlcv(p, timeframe_seconds=86400)
    assert df.height == 2
    assert df.schema[CANON_TIME].time_zone == "UTC"
    assert df[CANON_VOLUME].to_list() == [1000.0, 1500.0]
    assert not qa.has_errors


def test_load_ohlcv_short_aliases_and_bid_ask(tmp_path):
    content = (
        "ts,o,h,l,c,vol,bid,ask\n"
        "1704153600,1.1000,1.1050,1.0950,1.1020,500,1.1015,1.1025\n"
        "1704157200,1.1020,1.1080,1.1010,1.1070,600,1.1065,1.1075\n"
    )
    p = tmp_path / "short_cols.csv"
    p.write_text(content)
    df, qa = load_ohlcv(p, timeframe_seconds=3600)
    assert df.height == 2
    assert CANON_TIME in df.columns
    assert CANON_SPREAD in df.columns
    # Spread should be derived as ask - bid (0.0010)
    assert round(df[CANON_SPREAD][0], 4) == 0.0010
    assert not qa.has_errors


def test_load_ohlcv_semicolon_delimited(tmp_path):
    content = (
        "datetime;open;high;low;close;volume\n"
        "2024-01-02 00:00:00;1.1000;1.1050;1.0950;1.1020;100\n"
        "2024-01-02 01:00:00;1.1020;1.1080;1.1010;1.1070;150\n"
    )
    p = tmp_path / "semi.csv"
    p.write_text(content)
    df, qa = load_ohlcv(p, timeframe_seconds=3600)
    assert df.height == 2
    assert not qa.has_errors
    assert df[CANON_CLOSE].to_list() == [1.1020, 1.1070]


def test_load_ohlcv_malformed_missing_columns(tmp_path):
    content = "time,some_random_col\n2024-01-01,123\n"
    p = tmp_path / "missing_ohlc.csv"
    p.write_text(content)
    df, qa = load_ohlcv(p)
    assert qa.has_errors
    assert any(i.code == "missing_columns" for i in qa.issues)


def test_load_ohlcv_unparseable_time_column_raises(tmp_path):
    content = "time,open,high,low,close\nnot_a_date,1.1,1.2,1.0,1.1\n"
    p = tmp_path / "bad_date.csv"
    p.write_text(content)
    with pytest.raises(ValueError, match="Unable to parse"):
        load_ohlcv(p)


def test_resample_hourly_to_4h():
    df = synthetic_fx(n_bars=100, freq_seconds=3600)
    out = resample(df, "4h")
    assert out.height <= df.height
    assert out[CANON_TIME].is_sorted()
