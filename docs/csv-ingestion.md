# CSV & Parquet Data Ingestion Guide

PRIME QUANT includes a robust, cross-platform data loading and QA engine (`primequant.data.loader`) that allows you to run backtests, optimizations, and validation pipelines without requiring a live MetaTrader 5 terminal.

---

## 1. Supported File Formats

- **Delimited Text**: `.csv`, `.tsv`, `.txt`
  - Auto-detects delimiters: comma (`,`), tab (`\t`), semicolon (`;`), pipe (`|`), and whitespace.
- **Parquet**: `.parquet`, `.pq`
  - Zero-copy, high-performance binary storage (recommended for large historical datasets).

---

## 2. Canonical Column Schema

The loader maps column variants and broker exports into canonical lowercase fields:

| Canonical Column | Type | Accepted Aliases / Headers |
| :--- | :--- | :--- |
| `time` | `Datetime (UTC)` | `datetime`, `timestamp`, `date_time`, `date time`, `gmt time`, `time (utc)`, `<date> <time>` |
| `open` | `Float64` | `open`, `o`, `first`, `bid_open` |
| `high` | `Float64` | `high`, `h`, `max`, `bid_high` |
| `low` | `Float64` | `low`, `l`, `min`, `bid_low` |
| `close` | `Float64` | `close`, `c`, `last`, `price`, `bid_close` |
| `volume` *(optional)* | `Float64` | `volume`, `vol`, `v`, `tick_volume`, `tickvol`, `qty` |
| `spread` *(optional)* | `Int64` / `Float64` | `spread`, `points`, `spr` |

---

## 3. How to Ingest Custom Data

### Option A: Interactive Assistant Commands (Claude Code Style)

You can pass local file paths directly to PRIME QUANT in natural language:

```
load data from data/EURUSD_M5.csv and test an EMA 12/26 crossover strategy
```

Or:

```
run validation pipeline on data/BTCUSDT_1h.parquet with a trend breakout hypothesis
```

### Option B: Python API (`rlm.quant.load_data`)

```python
import rlm.quant

# Load local CSV or Parquet file
df = rlm.quant.load_data("data/EURUSD_M5.csv")

# Inspect normalized schema
print(df.schema)
# Output:
# {'time': Datetime(time_unit='us', time_zone=None), 'open': Float64, 'high': Float64, 'low': Float64, 'close': Float64, 'volume': Float64, 'spread': Int64}
```

### Option C: Engine Loader API (`primequant.data.loader.load_ohlcv`)

```python
from primequant.data.loader import load_ohlcv

# Returns normalized DataFrame and a Quality Assurance (QA) report
df, qa_result = load_ohlcv("data/GBPJPY_H1.csv")

print(f"Loaded {df.height} bars. QA Issues found: {len(qa_result.issues)}")
```

---

## 4. Built-in Data Quality Assurance (QA)

When ingesting data, the loader automatically checks for and surfaces:
- **Timestamp Out-of-Order**: Disordered or duplicate timestamps.
- **Bar Inconsistencies**: Low > High, Open/Close outside High-Low range.
- **Negative or Zero Prices**: Corrupted price ticks.
- **Large Time Gaps**: Missing weekend/holiday bars vs unexpected trading-hour gaps.
- **Spread Anomalies**: Extreme or inverted spreads.
