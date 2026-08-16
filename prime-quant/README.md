# Prime Quant — FX/CFD Quant Research Agent

Deterministic backtesting and validation engine wired into Prime Agent's
persistent IPython kernel. Designed to run natively on Windows against a local
MetaTrader 5 terminal.

## Prerequisites

- **Windows** with a running, logged-in [MetaTrader 5](https://www.metatrader5.com/) terminal
- **Node.js** >= 22.8
- **Python** >= 3.10 and **uv** (`pip install uv` or from [astral.sh](https://astral.sh))
- A Prime Agent provider (run `/login` in the TUI after first launch)

## Quick Start

```bash
cd prime-quant          # this repo root
npm install            # monorepo dependencies (one-time)
npm run tui            # starts the coding-agent TUI
```

On first launch the TUI bootstraps a Python kernel venv automatically (~30 s):
ipykernel, prime-agent-runtime, polars, numpy, optuna, MetaTrader5, and the
quant skill bundle are all installed into `~/.prime/agent/kernel-venv/`.

Inside the TUI:

```
/login                 # choose a provider and authenticate
```

## Usage

The quant skills live at `rlm.quant` in the IPython kernel:

```python
# Pull live data from MetaTrader 5
card = await rlm.quant.fetch_data("EURUSD", "M5", bars=5000)

# Run a backtest with validation
card = await rlm.quant.run_backtest("EURUSD M5 sma cross")

# Full pipeline: lint -> backtest -> validation gate -> tearsheet
card = await rlm.quant.run_pipeline(
    "EURUSD M5 sma cross",
    param_space={"fast": [5, 20], "slow": [20, 60]},
    report_path="tearsheet_EURUSD_M5.html",
)
```

All calls return compact JSON cards (< 150 tokens); raw frames stay in the
kernel scope (`_last_df`, `_last_trades`, etc.) and are never pasted into the
model context.

## Architecture

```
prime-quant/                      # Python engine (deterministic)
  src/primequant/
    data/mt5.py                   #   MT5Bridge (Windows IPC)
    data/loader.py                #   OHLCV load + QA
    backtest/engine.py            #   in-memory backtest
    validate/                     #   CPCV, walk-forward, AST lint
    optimize/                     #   Optuna parameter search
    report/tearsheet.py           #   HTML tearsheet export
    pipeline/orchestrator.py      #   full pipeline wiring

packages/coding-agent/
  skills/quant/                   # Agent skill bundle (kernel-side)
    src/quant/data.py             #   fetch_data (live MT5 pull)
    src/quant/runner.py            #   run_backtest, run_pipeline
    src/quant/idea_to_spec.py     #   prompt -> StrategySpec
    SKILL.md                      #   skill docs for the model

packages/coding-agent/src/
  core/kernel/bootstrap.ts        #   venv bootstrap (Windows-aware)
  skills.ts                       #   skill discovery + registration
```

## MT5 Environment Variables

| Variable | Description |
|---|---|
| `PRIME_QUANT_MT5_PATH` | Terminal executable path |
| `PRIME_QUANT_MT5_LOGIN` | Account login number |
| `PRIME_QUANT_MT5_PASSWORD` | Account password |
| `PRIME_QUANT_MT5_SERVER` | Broker server name |
| `PRIME_QUANT_MT5_TIMEOUT` | IPC timeout in ms |

Defaults rely on the auto-logged-in terminal; set these only for non-default
setups or portable installs.

## Testing

```bash
cd prime-quant
python -m pytest tests/ -q         # engine tests
```

Tests with a live MT5 terminal will auto-detect it and run IPC smoke checks;
without MT5 they skip gracefully.
