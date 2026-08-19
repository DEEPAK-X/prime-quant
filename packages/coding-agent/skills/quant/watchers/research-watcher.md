# Research Watcher Preset

The **Research Watcher** is a scheduled triage agent that processes queued strategy ideas, checks past failure patterns via `rlm.quant.recall_failures`, runs backtests and anti-overfit validation gates (CPCV + walk-forward DSR/PBO) via `rlm.quant.run_backtest`, logs failure patterns into durable harness memory via `rlm.quant.refine_log_failure`, and retains only passing candidates in a concise triage card.

---

## Configuration & Inputs

Configure ideas and data source via environment variables or prompt arguments:

| Variable | Type | Default | Description |
|---|---|---|---|
| `PRIME_QUANT_IDEA_QUEUE` | `str` | `"EURUSD M5 sma cross,EURUSD M5 breakout 20,GBPUSD M15 rsi_zone"` | Comma-separated list of strategy prompts to triage. |
| `PRIME_QUANT_TRIAGE_DATA` | `str` | `""` | Optional CSV/Parquet data path; if empty, uses kernel `df` or default synthetic data. |

---

## Scheduled Command

Schedule with `prime-agent schedule` (runs every 4 hours or daily by default):

```bash
prime-agent schedule "0 */4 * * *" "Run the Research Watcher: recall failures with rlm.quant.recall_failures(), evaluate queued strategy prompts from PRIME_QUANT_IDEA_QUEUE with rlm.quant.run_backtest, filter through the validation gate (DSR/PBO), log failed patterns via rlm.quant.refine_log_failure, and return a compact triage summary card (<150 tokens)."
```

---

## Exact Prompt Template

```markdown
You are the PRIME QUANT Research Watcher.
Execute the following Python logic in the kernel using rlm.quant:

```python
import os, json

queue_raw = os.environ.get("PRIME_QUANT_IDEA_QUEUE", "EURUSD M5 sma cross,EURUSD M5 breakout 20")
ideas = [i.strip() for i in queue_raw.split(",") if i.strip()]
data_path = os.environ.get("PRIME_QUANT_TRIAGE_DATA") or None

# 1. Recall historical failure patterns to avoid repeating known dead-ends
memory = await rlm.quant.recall_failures()

passed_ideas = []
failed_ideas = []

for idea in ideas:
    card_json = await rlm.quant.run_backtest(idea, data=data_path, validate=True)
    res = json.loads(card_json)
    if res.get("status") != "success":
        failed_ideas.append({"idea": idea, "reason": res.get("error", {}).get("message", "error")})
        continue
    
    gate = res.get("validation_gate", {})
    metrics = res.get("metrics", {})
    if gate.get("passed", False):
        passed_ideas.append({
            "idea": idea,
            "sharpe": round(float(metrics.get("sharpe", 0.0)), 2),
            "pbo": round(float(gate.get("pbo", 1.0)), 2),
        })
    else:
        pbo_val = gate.get("pbo")
        reason = f"Gate fail: PBO={pbo_val}" if pbo_val is not None else "Gate fail"
        failed_ideas.append({"idea": idea, "reason": reason})
        await rlm.quant.refine_log_failure({
            "kind": "validation_gate",
            "pattern": f"Triage gate fail on {idea}: PBO {pbo_val}",
            "metric": "pbo",
            "value": pbo_val,
        })

top_candidate = max(passed_ideas, key=lambda x: x["sharpe"]) if passed_ideas else None

card_out = {
    "status": "ok",
    "watcher": "research_watcher",
    "queued": len(ideas),
    "passed_count": len(passed_ideas),
    "failed_count": len(failed_ideas),
    "top_candidate": top_candidate,
}
print(json.dumps(card_out))
```

Return ONLY the compact JSON output card.
```

---

## Expected Card Output Format (< 150 tokens)

### Triage Results (Passing Candidate Found)
```json
{
  "status": "ok",
  "watcher": "research_watcher",
  "queued": 3,
  "passed_count": 1,
  "failed_count": 2,
  "top_candidate": {
    "idea": "EURUSD M5 sma cross",
    "sharpe": 1.42,
    "pbo": 0.12
  }
}
```

### Triage Results (All Failed Anti-Overfit Gate)
```json
{
  "status": "ok",
  "watcher": "research_watcher",
  "queued": 2,
  "passed_count": 0,
  "failed_count": 2,
  "top_candidate": null
}
```
