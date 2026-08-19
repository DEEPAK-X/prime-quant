# MetaTrader 5 (MT5) Setup Guide

This guide walks through configuring MetaTrader 5 on Windows for use with PRIME QUANT's live market data acquisition and backtesting engine.

---

## 1. Prerequisites

1. **Windows 10/11 x64** (or Windows Server).
2. **MetaTrader 5 Terminal** (installed from your broker or [MetaQuotes](https://www.metatrader5.com/)).
3. **CPython 3.11+** (automatically provisioned into `~/.prime/agent/kernel-venv/` during first run).

---

## 2. Terminal Configuration

For PRIME QUANT to interact with MT5 via IPC, the terminal must permit automated algorithmic trading and external DLL/IPC calls.

1. Open **MetaTrader 5**.
2. Navigate to **Tools** → **Options** (`Ctrl + O`).
3. Click the **Expert Advisors** tab.
4. Check the following options:
   - `[x] Allow algorithmic trading`
   - `[x] Allow DLL imports`
   - `[x] Allow WebRequest for listed URL` (optional)
5. Log into your Demo or Live broker trading account (**File** → **Login to Trade Account**).

---

## 3. Data Sync in MT5

Before running high-timeframe or multi-year backtests, ensure historical bars are downloaded to your local terminal:

1. In MT5, press `F2` to open the **Symbols** window.
2. Select your desired symbol (e.g. `EURUSD`, `GBPUSD`, `XAUUSD`, `BTCUSD`).
3. Click the **Bars** or **Ticks** tab.
4. Select the timeframe (e.g. `M5`, `H1`) and click **Request** to download history from the broker server.

---

## 4. Using MT5 in PRIME QUANT

PRIME QUANT connects to your running MT5 terminal automatically using the `MetaTrader5` Python binding in the kernel virtualenv.

### Interactive CLI / TUI Commands

Inside an interactive PRIME QUANT chat or session, you can request data fetching directly in natural language:

```
fetch 5000 bars of EURUSD M5 from MT5 and run a baseline backtest
```

### Python API Usage (`rlm.quant.fetch_data`)

```python
import rlm.quant

# Fetch 5,000 bars of EURUSD 5-minute data
df = rlm.quant.fetch_data(
    symbol="EURUSD",
    timeframe="M5",
    n_bars=5000,
)

print(df)
# Returns a canonical Polars DataFrame:
# [time, open, high, low, close, volume, spread, bid, ask]
```

### Supported Timeframes
- Minute: `M1`, `M2`, `M3`, `M4`, `M5`, `M6`, `M10`, `M12`, `M15`, `M20`, `M30`
- Hour: `H1`, `H2`, `H3`, `H4`, `H6`, `H8`, `H12`
- Day/Week/Month: `D1`, `W1`, `MN1`

---

## 5. Health Probes and Verification

- In the **Web GUI (`/gui`)**: The top status bar monitors MT5 connection state (`MT5: OK` or `MT5: DISCONNECTED`).
- In the REST API: `GET http://127.0.0.1:3001/api/mt5` returns `{ status: "ok" | "unreachable", detail: null | "..." }`.
