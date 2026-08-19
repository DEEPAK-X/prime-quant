# Flow Watcher Preset

The **Flow Watcher** is a scheduled monitoring agent that periodically pulls live market data via `rlm.quant.fetch_data` across a watchlist of symbols, calculates rolling volume z-scores, relative volume (RVOL), and ATR volatility surges on the bound kernel `df`, and surfaces market flow anomalies as a compact summary card.

---

## Configuration & Inputs

Configure watchlist and thresholds via environment variables or prompt arguments:

| Variable | Type | Default | Description |
|---|---|---|---|
| `PRIME_QUANT_WATCH_SYMBOLS` | `str` | `"EURUSD,GBPUSD,USDJPY"` | Comma-separated list of symbols to monitor. |
| `PRIME_QUANT_TIMEFRAME` | `str` | `"M5"` | Bar timeframe label (e.g. `"M1"`, `"M5"`, `"M15"`, `"H1"`). |
| `PRIME_QUANT_BARS` | `int` | `100` | Number of recent closed bars to pull for baseline calculation. |
| `PRIME_QUANT_VOL_ZSCORE_THRESH` | `float` | `2.5` | Volume anomaly z-score threshold (standard deviations above mean). |
| `PRIME_QUANT_RVOL_THRESH` | `float` | `2.0` | Relative volume threshold ($V / \bar{V}$). |

---

## Scheduled Command

Schedule with `prime-agent schedule` (runs every 5 minutes by default):

```bash
prime-agent schedule "*/5 * * * *" "Run the Flow Watcher: pull recent bars for PRIME_QUANT_WATCH_SYMBOLS via rlm.quant.fetch_data(symbol, timeframe=PRIME_QUANT_TIMEFRAME, bars=100), compute RVOL and volume z-scores on kernel df, detect spikes exceeding thresholds, and return a compact status card (<150 tokens)."
```

---

## Exact Prompt Template

```markdown
You are the PRIME QUANT Flow Watcher.
Execute the following Python logic in the kernel using rlm.quant:

```python
import os, json
import polars as pl

symbols = [s.strip() for s in os.environ.get("PRIME_QUANT_WATCH_SYMBOLS", "EURUSD,GBPUSD,USDJPY").split(",") if s.strip()]
tf = os.environ.get("PRIME_QUANT_TIMEFRAME", "M5")
bars = int(os.environ.get("PRIME_QUANT_BARS", "100"))
z_thresh = float(os.environ.get("PRIME_QUANT_VOL_ZSCORE_THRESH", "2.5"))
rvol_thresh = float(os.environ.get("PRIME_QUANT_RVOL_THRESH", "2.0"))

anomalies = []

for sym in symbols:
    card_json = await rlm.quant.fetch_data(sym, timeframe=tf, bars=bars)
    res = json.loads(card_json)
    if res.get("status") != "success":
        continue
    
    # Kernel scope has the frame bound as df
    v_col = "volume" if "volume" in df.columns else ("tick_volume" if "tick_volume" in df.columns else None)
    if not v_col or df.height < 20:
        continue
        
    v_series = df[v_col].drop_nulls()
    last_v = float(v_series[-1])
    hist = v_series[:-1]
    mean_v = float(hist.mean())
    std_v = float(hist.std()) if hist.std() is not None else 0.0
    
    rvol = round(last_v / mean_v, 2) if mean_v > 0 else 1.0
    zscore = round((last_v - mean_v) / std_v, 2) if std_v > 0 else 0.0
    
    if zscore >= z_thresh or rvol >= rvol_thresh:
        anomalies.append({"sym": sym, "rvol": rvol, "z": zscore})

card_out = {
    "status": "ok",
    "watcher": "flow_watcher",
    "scanned": len(symbols),
    "timeframe": tf,
    "anomalies": anomalies,
    "anomaly_count": len(anomalies),
}
print(json.dumps(card_out))
```

Return ONLY the compact JSON output card.
```

---

## Expected Card Output Format (< 150 tokens)

### Clean Market State (No Anomalies)
```json
{
  "status": "ok",
  "watcher": "flow_watcher",
  "scanned": 3,
  "timeframe": "M5",
  "anomalies": [],
  "anomaly_count": 0
}
```

### Anomaly Detected (Volume/Volatility Surge)
```json
{
  "status": "ok",
  "watcher": "flow_watcher",
  "scanned": 3,
  "timeframe": "M5",
  "anomalies": [
    {"sym": "EURUSD", "rvol": 3.4, "z": 2.9}
  ],
  "anomaly_count": 1
}
```
