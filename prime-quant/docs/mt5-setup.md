# MetaTrader 5 (MT5) Setup Guide

This guide walks through configuring MetaTrader 5 on Windows for use with PRIME QUANT's live market data acquisition and backtesting engine.

---

## 1. Terminal Installation

1. Download and install [MetaTrader 5](https://www.metatrader5.com/) (or the MT5 installer provided by your broker).
2. Complete the initial installation on Windows 10/11 x64.
3. Open MetaTrader 5 and log into your broker demo or live account (**File** → **Login to Trade Account**).

---

## 2. Terminal Configuration & Market Watch

### Enabling Algorithmic Trading
For PRIME QUANT to interact with MT5 via IPC, the terminal must allow automated trading and external DLL/IPC calls:
1. In MT5, navigate to **Tools** → **Options** (`Ctrl + O`).
2. Select the **Expert Advisors** tab.
3. Check:
   - `[x] Allow algorithmic trading`
   - `[x] Allow DLL imports`
4. Click **OK**.

### Adding Symbols to Market Watch
MT5 only exposes history and real-time ticks for symbols visible in your Market Watch:
1. Press `Ctrl + M` to open the **Market Watch** window.
2. Right-click inside Market Watch and select **Show All**, or click the search box to add specific symbols (e.g., `EURUSD`, `GBPUSD`, `XAUUSD`, `BTCUSD`).
3. (Optional) Press `F2` to open the **Symbols** dialog, select the desired symbol and timeframe (e.g. `M5`), and click **Request** to pre-download historical bars from the broker.

---

## 3. Environment Variables

By default, PRIME QUANT connects automatically to the currently running and logged-in MT5 terminal. For non-default installations, portable instances, or automated background sessions, set the following environment variables:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `PRIME_QUANT_MT5_PATH` | Full path to `terminal64.exe` | `C:\Program Files\MetaTrader 5\terminal64.exe` |
| `PRIME_QUANT_MT5_LOGIN` | Broker account login number | `12345678` |
| `PRIME_QUANT_MT5_PASSWORD` | Broker account password | `YourPassword123` |
| `PRIME_QUANT_MT5_SERVER` | Broker server name | `MetaQuotes-Demo` |
| `PRIME_QUANT_MT5_TIMEOUT` | IPC connection timeout in milliseconds | `60000` |

---

## 4. Verifying with `rlm.quant.fetch_data`

To verify the connection in an interactive session, run:

```python
import rlm.quant

# Fetch 5,000 bars of EURUSD 5-minute data from MT5
card = await rlm.quant.fetch_data("EURUSD", "M5", bars=5000)
print(card)
```

Expected output card:
```json
{
  "status": "success",
  "symbol": "EURUSD",
  "timeframe": "M5",
  "n_bars": 5000,
  "start": "2024-01-02T00:00:00Z",
  "end": "2024-03-15T21:55:00Z"
}
```

The underlying Polars DataFrame is bound to `_last_df` in the IPython kernel scope with canonical columns: `[time, open, high, low, close, volume, spread, bid, ask]`.
