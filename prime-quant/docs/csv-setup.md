# CSV & Parquet Data Ingestion Guide

PRIME QUANT supports running backtests, walk-forward validation, and parameter optimization without a live MetaTrader 5 terminal using historical broker CSV, TSV, or Parquet exports.

---

## 1. Broker Export → `rlm.quant.load_data` Workflow

1. Export historical bars from your broker, TradingView, MT4/MT5, Yahoo Finance, or crypto exchange as a `.csv`, `.tsv`, or `.parquet` file.
2. Place the file in your repository (e.g. `prime-quant/data/EURUSD_M5.csv`).
3. Load the data directly in an interactive session or Python script:

```python
import rlm.quant

# Load local CSV / Parquet file
df = rlm.quant.load_data("data/EURUSD_M5.csv")

# Run backtest or full pipeline on the loaded data
card = await rlm.quant.run_backtest("EURUSD M5 sma cross", data=df)
print(card)
```

The loader automatically detects delimiters (comma, tab, semicolon, pipe, whitespace) and returns a validated Polars DataFrame.

---

## 2. Supported Column Variants

The loader automatically normalizes heterogeneous broker column headers into canonical lowercase columns:

| Canonical Column | Accepted Aliases / Headers | Description |
| :--- | :--- | :--- |
| `time` | `datetime`, `timestamp`, `date_time`, `date time`, `gmt time`, `time (utc)`, `<date> <time>` | Bar opening timestamp |
| `open` | `open`, `o`, `first`, `bid_open` | Opening price |
| `high` | `high`, `h`, `max`, `bid_high` | Highest price |
| `low` | `low`, `l`, `min`, `bid_low` | Lowest price |
| `close` | `close`, `c`, `last`, `price`, `bid_close` | Closing price |
| `volume` *(optional)* | `volume`, `vol`, `v`, `tick_volume`, `tickvol`, `qty` | Traded volume or tick count |
| `spread` *(optional)* | `spread`, `points`, `spr` | Spread in broker points |
| `bid` / `ask` *(optional)* | `bid`, `ask`, `bid_price`, `ask_price` | Exact quote bounds |

---

## 3. Timezone Handling (UTC)

- All timestamps are converted to timezone-naive UTC datetime representations in microsecond resolution (`Datetime(time_unit="us")`).
- ISO-8601 strings, UNIX epoch seconds/milliseconds, and combined `<DATE> <TIME>` columns (e.g. `2024.01.02 00:00:00`) are parsed automatically.
- Gaps (weekends, holidays) and disordered bars are surfaced in the accompanying QA report without silently corrupting test folds.

---

## 4. Parquet Format Note

For large historical datasets (> 100,000 bars or multi-year M1 data), **Parquet** (`.parquet` / `.pq`) is strongly recommended over CSV:
- **Speed**: 10x–50x faster load times via zero-copy Polars memory mapping.
- **Size**: 70%–85% smaller file sizes due to Snappy/ZSTD columnar compression.
- **Type Safety**: Preserves native datetime and float64 datatypes without repeated string parsing.

To convert a CSV to Parquet using Polars:
```python
from primequant.data.loader import load_ohlcv

df, _ = load_ohlcv("data/EURUSD_M5.csv")
df.write_parquet("data/EURUSD_M5.parquet")
```
