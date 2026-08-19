# Risk Watcher Preset

The **Risk Watcher** is a scheduled monitoring agent that periodically inspects portfolio performance, computes drawdown and daily loss from the active trading/backtest results, verifies them against configured risk thresholds, and automatically records breach patterns into harness failure memory via `rlm.quant.refine_log_failure`.

---

## Configuration & Inputs

Configure thresholds via environment variables or prompt parameters:

| Variable | Type | Default | Description |
|---|---|---|---|
| `PRIME_QUANT_MAX_DRAWDOWN` | `float` | `0.05` | Maximum allowable peak-to-trough drawdown fraction (e.g. `0.05` = 5.0%). |
| `PRIME_QUANT_MAX_DAILY_LOSS_USD` | `float` | `500.0` | Maximum allowable daily loss in quote currency (USD). |
| `PRIME_QUANT_RISK_STRATEGY` | `str` | `""` | Optional prompt or spec string to re-evaluate if no active run is in scope. |

---

## Scheduled Command

Schedule with `prime-agent schedule` (runs every 15 minutes by default):

```bash
prime-agent schedule "*/15 * * * *" "Run the Risk Watcher: check current drawdown and daily PnL against limits. If _last_result is available in kernel scope, inspect metrics; otherwise run rlm.quant.run_backtest on the configured strategy. If max_drawdown_pct exceeds PRIME_QUANT_MAX_DRAWDOWN or daily loss exceeds PRIME_QUANT_MAX_DAILY_LOSS_USD, log the failure via rlm.quant.refine_log_failure and return a status:alert card (<150 tokens)."
```

---

## Exact Prompt Template

```markdown
You are the PRIME QUANT Risk Watcher.
Execute the following Python logic in the kernel using rlm.quant:

```python
import os, json
max_dd = float(os.environ.get("PRIME_QUANT_MAX_DRAWDOWN", "0.05"))
max_loss = float(os.environ.get("PRIME_QUANT_MAX_DAILY_LOSS_USD", "500.0"))

# Inspect most recent backtest or run current spec
if "_last_result" in globals() and _last_result is not None:
    res = _last_result
    dd_pct = float(res.metrics.get("max_drawdown_pct", 0.0))
    pnl_usd = float(res.metrics.get("net_profit_usd", 0.0))
else:
    spec = os.environ.get("PRIME_QUANT_RISK_STRATEGY", "EURUSD M5 sma cross")
    card_json = await rlm.quant.run_backtest(spec)
    card = json.loads(card_json)
    metrics = card.get("metrics", {})
    dd_pct = float(metrics.get("max_drawdown_pct", 0.0))
    pnl_usd = float(metrics.get("expectancy", 0.0))

breach = (dd_pct > max_dd) or (pnl_usd < -max_loss)

if breach:
    pattern = f"Risk limit breach: DD {dd_pct:.2%} (limit {max_dd:.2%}) or Loss ${abs(pnl_usd):.2f}"
    await rlm.quant.refine_log_failure({
        "kind": "risk_limit",
        "pattern": pattern,
        "metric": "max_drawdown_pct",
        "value": dd_pct,
        "threshold": max_dd,
    })

out = {
    "status": "alert" if breach else "ok",
    "watcher": "risk_watcher",
    "drawdown_pct": round(dd_pct, 4),
    "limit_max_dd": max_dd,
    "limit_breach": breach,
    "logged_failure": breach,
}
print(json.dumps(out))
```

Return ONLY the compact JSON output card.
```

---

## Expected Card Output Format (< 150 tokens)

### Normal Status (No Breach)
```json
{
  "status": "ok",
  "watcher": "risk_watcher",
  "drawdown_pct": 0.024,
  "limit_max_dd": 0.05,
  "limit_breach": false,
  "logged_failure": false
}
```

### Alert Status (Breach Detected & Logged)
```json
{
  "status": "alert",
  "watcher": "risk_watcher",
  "drawdown_pct": 0.062,
  "limit_max_dd": 0.05,
  "limit_breach": true,
  "logged_failure": true
}
```
