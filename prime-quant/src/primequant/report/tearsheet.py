"""Minimalist dark-mode HTML tearsheet generator.

Produces a self-contained single-file HTML report with a quant-terminal
aesthetic: 1px solid border lines, monospace data fonts, high-contrast
tabular readouts, inline SVG charts. No external CDN dependencies, no JS
frameworks, no rounded bubble gradients.

Context budget protection: the function writes the HTML to disk and returns
ONLY ``{"report_path": str, "file_size_kb": float}``. Raw HTML never enters
the agent context.
"""

from __future__ import annotations

import html
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from primequant.backtest.engine import BacktestResult
from primequant.validate.pipeline import ValidationEvidence


def _fmt(v: Any, digits: int = 4) -> str:
    """Format a number for tabular display."""
    if v is None:
        return "-"
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return "inf" if v > 0 else "-inf"
        return f"{v:.{digits}f}"
    return str(v)


def _pct(v: Any, digits: int = 2) -> str:
    if v is None:
        return "-"
    try:
        return f"{float(v) * 100:.{digits}f}%"
    except (TypeError, ValueError):
        return str(v)


def _escape(s: str) -> str:
    return html.escape(str(s))


@dataclass
class TearsheetMeta:
    """Optional metadata for the header grid."""

    symbol: str = "EURUSD"
    timeframe: str = "1H"
    date_range: str = "-"
    total_trades: int = 0


def _build_header_grid(meta: TearsheetMeta, metrics: dict) -> str:
    win_rate = _pct(metrics.get("win_rate"))
    pf = _fmt(metrics.get("profit_factor"))
    rows = [
        ("Symbol", meta.symbol),
        ("Timeframe", meta.timeframe),
        ("Date Range", meta.date_range),
        ("Total Trades", str(meta.total_trades)),
        ("Win Rate", win_rate),
        ("Profit Factor", pf),
    ]
    cells = "".join(
        f'<div class="hdr-cell"><div class="hdr-label">{_escape(label)}</div>'
        f'<div class="hdr-val">{_escape(val)}</div></div>'
        for label, val in rows
    )
    return f'<div class="hdr-grid">{cells}</div>'


def _build_perf_table(metrics: dict) -> str:
    rows = [
        ("Sharpe Ratio", _fmt(metrics.get("sharpe"))),
        ("Sortino Ratio", _fmt(metrics.get("sortino"))),
        ("Calmar Ratio", _fmt(metrics.get("calmar"))),
        ("Max Drawdown %", _pct(metrics.get("max_drawdown_pct"))),
        ("Expectancy ($/lot)", _fmt(metrics.get("expectancy"), 2)),
        ("Annualized Return", _pct(metrics.get("annualized_return"))),
        ("Final Equity", _fmt(metrics.get("final_equity"), 2)),
    ]
    body = "".join(
        f"<tr><td class='k'>{_escape(k)}</td><td class='v'>{_escape(v)}</td></tr>"
        for k, v in rows
    )
    return f"<table class='tbl'><tbody>{body}</tbody></table>"


def _build_validation_card(ev: ValidationEvidence | None) -> str:
    if ev is None:
        return (
            "<div class='card warn'><div class='card-title'>VALIDATION</div>"
            "<div class='card-body'>No validation evidence supplied.</div></div>"
        )
    fc = ev.fold_consistency or {}
    dsr = ev.dsr or {}
    pbo = ev.pbo or {}
    deg = ev.degradation or {}
    status = "PASS" if ev.passed else "FAIL"
    cls = "pass" if ev.passed else "fail"
    rows = [
        ("CPCV Fold Consistency", _pct(fc.get("positive_fold_rate"))),
        ("Deflated Sharpe (DSR)", _fmt(dsr.get("dsr"))),
        ("Prob. Backtest Overfit (PBO)", _fmt(pbo.get("pbo"))),
        ("IS vs OOS Degradation", _pct(deg.get("degradation_pct"))),
        ("OOS Sharpe (mean)", _fmt(ev.oos_sharpe_mean)),
        ("IS Sharpe (mean)", _fmt(ev.is_sharpe_mean)),
    ]
    body = "".join(
        f"<tr><td class='k'>{_escape(k)}</td><td class='v'>{_escape(v)}</td></tr>"
        for k, v in rows
    )
    reasons = ""
    if ev.failure_reasons:
        items = "".join(f"<li>{_escape(r)}</li>" for r in ev.failure_reasons)
        reasons = f"<ul class='reasons'>{items}</ul>"
    return (
        f"<div class='card {cls}'><div class='card-title'>VALIDATION GATE: {status}</div>"
        f"<table class='tbl'><tbody>{body}</tbody></table>{reasons}</div>"
    )


def _equity_svg(equity: list[float], width: int = 760, height: int = 220) -> str:
    """Dual-axis: equity curve (top) + underwater drawdown (bottom)."""
    if len(equity) < 2:
        return "<div class='empty'>Insufficient data for equity curve.</div>"
    n = len(equity)
    eq_min, eq_max = min(equity), max(equity)
    eq_range = (eq_max - eq_min) or 1.0

    # Drawdown series.
    running_max = equity[0]
    dd: list[float] = []
    for v in equity:
        running_max = max(running_max, v)
        dd.append((v - running_max) / (running_max or 1.0))
    dd_min = min(dd) if dd else 0.0
    dd_range = abs(dd_min) or 1.0

    pad_l, pad_r, pad_t, pad_b = 48, 12, 12, 24
    plot_w = width - pad_l - pad_r
    eq_h = (height - pad_t - pad_b) * 0.62
    dd_h = (height - pad_t - pad_b) * 0.38
    dd_top = pad_t + eq_h + 4

    def x(i: int) -> float:
        return pad_l + (i / (n - 1)) * plot_w

    def y_eq(v: float) -> float:
        return pad_t + (1 - (v - eq_min) / eq_range) * eq_h

    def y_dd(v: float) -> float:
        # v <= 0; 0 at top (dd_top), dd_min at bottom.
        return dd_top + (abs(v) / dd_range) * dd_h

    eq_pts = " ".join(f"{x(i):.1f},{y_eq(v):.1f}" for i, v in enumerate(equity))
    dd_pts = " ".join(f"{x(i):.1f},{y_dd(v):.1f}" for i, v in enumerate(dd))

    # Gridlines + axis labels.
    gridlines = ""
    for g in range(5):
        gy = pad_t + (g / 4) * eq_h
        gridlines += f"<line x1='{pad_l}' y1='{gy:.1f}' x2='{width-pad_r}' y2='{gy:.1f}' class='grid'/>"
        val = eq_max - (g / 4) * eq_range
        gridlines += f"<text x='{pad_l-6}' y='{gy+3:.1f}' class='axis'>{val:.0f}</text>"
    for g in range(1, 4):
        gy = dd_top + (g / 3) * dd_h
        gridlines += f"<line x1='{pad_l}' y1='{gy:.1f}' x2='{width-pad_r}' y2='{gy:.1f}' class='grid'/>"
        val = (g / 3) * dd_min * 100
        gridlines += f"<text x='{pad_l-6}' y='{gy+3:.1f}' class='axis'>{val:.1f}%</text>"

    return f"""
<svg viewBox='0 0 {width} {height}' class='chart' preserveAspectRatio='xMidYMid meet'>
  <rect x='0' y='0' width='{width}' height='{height}' class='chart-bg'/>
  {gridlines}
  <polyline points='{eq_pts}' class='eq-line'/>
  <line x1='{pad_l}' y1='{dd_top}' x2='{width-pad_r}' y2='{dd_top}' class='zero'/>
  <polyline points='{dd_pts}' class='dd-line'/>
  <text x='{pad_l}' y='{pad_t-2}' class='axis-label'>EQUITY</text>
  <text x='{pad_l}' y='{dd_top-2}' class='axis-label'>DRAWDOWN</text>
</svg>"""


def _returns_heatmap_svg(
    equity: list[float], width: int = 760, height: int = 200
) -> str:
    """Monthly returns heatmap grid (12 cols x N rows)."""
    if len(equity) < 13:
        return "<div class='empty'>Insufficient data for monthly heatmap.</div>"
    # Bucket equity into ~22-bar months (daily data assumption).
    month_len = max(1, len(equity) // 24)
    months: list[float] = []
    for i in range(0, len(equity) - 1, month_len):
        chunk = equity[i : i + month_len + 1]
        if len(chunk) < 2:
            break
        months.append((chunk[-1] - chunk[0]) / chunk[0])
    if len(months) < 2:
        return "<div class='empty'>Insufficient monthly buckets.</div>"

    # Arrange into rows of 12 (calendar years).
    n_cols = min(12, len(months))
    n_rows = (len(months) + n_cols - 1) // n_cols
    cell_w = (width - 48) / n_cols
    cell_h = min(22, (height - 24) / max(n_rows, 1))
    pad_l, pad_t = 48, 20

    max_abs = max(abs(m) for m in months) or 1.0
    cells = ""
    month_labels = "J F M A M J J A S O N D".split()

    for idx, ret in enumerate(months):
        r, c = idx // n_cols, idx % n_cols
        cx = pad_l + c * cell_w
        cy = pad_t + r * cell_h
        # Red-green diverging, dark-mode muted.
        if ret >= 0:
            intensity = 0.15 + 0.85 * (ret / max_abs)
            fill = f"rgb({int(40*intensity):d},{int(160*intensity):d},{int(80*intensity):d})"
        else:
            intensity = 0.15 + 0.85 * (abs(ret) / max_abs)
            fill = f"rgb({int(180*intensity):d},{int(50*intensity):d},{int(60*intensity):d})"
        cells += (
            f"<rect x='{cx:.1f}' y='{cy:.1f}' width='{cell_w-1:.1f}' height='{cell_h-1:.1f}' fill='{fill}'/>"
            f"<text x='{cx+cell_w/2:.1f}' y='{cy+cell_h/2+3:.1f}' class='cell-text'>{ret*100:.1f}</text>"
        )

    # Month labels.
    labels = "".join(
        f"<text x='{pad_l + (c+0.3)*cell_w:.1f}' y='{pad_t-6}' class='axis'>{m}</text>"
        for c, m in enumerate(month_labels[:n_cols])
    )

    total_h = pad_t + n_rows * cell_h + 8
    return f"""
<svg viewBox='0 0 {width} {total_h}' class='chart' preserveAspectRatio='xMidYMid meet'>
  <rect x='0' y='0' width='{width}' height='{total_h}' class='chart-bg'/>
  {labels}
  {cells}
  <text x='{pad_l}' y='{total_h-2}' class='axis-label'>MONTHLY RETURNS %</text>
</svg>"""


_CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0d1117; color: #c9d1d9;
  font-family: 'JetBrains Mono','Fira Code','Courier New',monospace;
  font-size: 13px; padding: 20px; line-height: 1.5;
}
.wrap { max-width: 820px; margin: 0 auto; }
.title {
  color: #58a6ff; border-bottom: 1px solid #2d3748;
  padding-bottom: 8px; margin-bottom: 16px;
  font-size: 15px; letter-spacing: 0.5px;
}
.subtitle { color: #8b949e; font-size: 11px; margin-bottom: 16px; }
.hdr-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; background: #2d3748; border: 1px solid #2d3748; margin-bottom: 16px; }
.hdr-cell { background: #161b22; padding: 8px 10px; }
.hdr-label { color: #8b949e; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.hdr-val { color: #e6edf3; font-size: 14px; margin-top: 2px; }
.section { color: #58a6ff; border-bottom: 1px solid #2d3748; padding-bottom: 4px; margin: 18px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
.tbl { width: 100%; border-collapse: collapse; border: 1px solid #2d3748; }
.tbl td { border: 1px solid #2d3748; padding: 5px 10px; }
.tbl td.k { color: #8b949e; background: #161b22; width: 55%; font-size: 11px; text-transform: uppercase; }
.tbl td.v { color: #e6edf3; text-align: right; font-size: 13px; }
.card { border: 1px solid #2d3748; margin-bottom: 16px; }
.card-title { padding: 6px 10px; border-bottom: 1px solid #2d3748; font-size: 11px; letter-spacing: 0.5px; }
.card.pass .card-title { color: #3fb950; }
.card.fail .card-title { color: #f85149; }
.card.warn .card-title { color: #d29922; }
.card-body { padding: 8px 10px; color: #8b949e; }
.reasons { list-style: none; padding: 8px 10px; }
.reasons li { color: #f85149; font-size: 11px; padding: 2px 0; }
.chart { width: 100%; height: auto; border: 1px solid #2d3748; margin-bottom: 16px; background: #161b22; }
.chart-bg { fill: #161b22; }
.eq-line { fill: none; stroke: #58a6ff; stroke-width: 1.2; }
.dd-line { fill: none; stroke: #f85149; stroke-width: 1.0; }
.grid { stroke: #2d3748; stroke-width: 0.5; }
.zero { stroke: #30363d; stroke-width: 0.8; stroke-dasharray: 2,2; }
.axis { fill: #8b949e; font-size: 9px; font-family: 'JetBrains Mono',monospace; }
.axis-label { fill: #8b949e; font-size: 9px; font-family: 'JetBrains Mono',monospace; letter-spacing: 0.5px; }
.cell-text { fill: #c9d1d9; font-size: 8px; font-family: 'JetBrains Mono',monospace; text-anchor: middle; }
.empty { color: #8b949e; padding: 12px; border: 1px solid #2d3748; text-align: center; }
.grid-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; }
"""


def generate_html_tearsheet(
    backtest_result: BacktestResult,
    validation_evidence: ValidationEvidence | None = None,
    output_path: str | Path | None = None,
    *,
    meta: TearsheetMeta | None = None,
) -> dict:
    """Generate a self-contained HTML tearsheet and write it to disk.

    Returns ONLY ``{"report_path": str, "file_size_kb": float}`` to protect
    the agent context budget. The raw HTML never leaves this function.
    """
    metrics = dict(backtest_result.metrics or {})
    equity = list(backtest_result.equity or [])
    meta = meta or TearsheetMeta(
        symbol=metrics.get("instrument", "EURUSD"),
        total_trades=metrics.get("n_trades", len(backtest_result.trades)),
    )

    header = _build_header_grid(meta, metrics)
    perf = _build_perf_table(metrics)
    val_card = _build_validation_card(validation_evidence)
    eq_chart = _equity_svg(equity)
    heatmap = _returns_heatmap_svg(equity)

    doc = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PrimeQuant Tearsheet - {_escape(meta.symbol)}</title>
<style>{_CSS}</style></head>
<body><div class="wrap">
<div class="title">PRIMEQUANT // BACKTEST TEARSHEET</div>
<div class="subtitle">Symbol {_escape(meta.symbol)} | {_escape(meta.timeframe)} | {_escape(meta.date_range)}</div>
{header}
<div class="section">CORE PERFORMANCE</div>
{perf}
<div class="section">VALIDATION &amp; ANTI-OVERFIT GATE</div>
{val_card}
<div class="section">EQUITY &amp; DRAWDOWN</div>
{eq_chart}
<div class="section">MONTHLY RETURNS</div>
{heatmap}
</div></body></html>"""

    out = Path(output_path) if output_path else Path.cwd() / f"tearsheet_{meta.symbol}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc, encoding="utf-8")
    size_kb = out.stat().st_size / 1024.0
    return {"report_path": str(out), "file_size_kb": float(round(size_kb, 2))}
