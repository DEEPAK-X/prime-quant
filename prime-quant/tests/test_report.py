"""Tests for the minimalist HTML tearsheet generator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from primequant.backtest.engine import run_backtest
from primequant.report.tearsheet import generate_html_tearsheet, TearsheetMeta
from primequant.strategy.base import MomentumStrategy
from primequant.validate.pipeline import ValidationEvidence
from tests._fxdata import synthetic_fx


def _passed_evidence(**overrides) -> ValidationEvidence:
    base = dict(
        passed=True,
        failure_reasons=[],
        cpcv_summary={"n_folds": 10},
        walk_forward_summary={"n_folds": 4},
        dsr={"dsr": 0.97, "n_trials": 1},
        pbo={"pbo": 0.3},
        degradation={"degradation_pct": 0.2},
        fold_consistency={"positive_fold_rate": 0.7},
        oos_sharpe_mean=0.5,
        is_sharpe_mean=0.7,
    )
    base.update(overrides)
    return ValidationEvidence(**base)


class TestTearsheet:
    def test_tearsheet_html_output(self, tmp_path):
        """Generate valid, non-empty HTML with expected SVG elements and
        correct metric values embedded."""
        df = synthetic_fx(n_bars=200)
        bt = run_backtest(df, MomentumStrategy(fast=5, slow=20))
        out = tmp_path / "ts.html"

        result = generate_html_tearsheet(
            bt,
            validation_evidence=_passed_evidence(),
            output_path=out,
            meta=TearsheetMeta(symbol="EURUSD", timeframe="1H", date_range="2024-01"),
        )

        # Context budget: only path + size returned, no raw HTML.
        assert set(result.keys()) == {"report_path", "file_size_kb"}
        assert result["report_path"] == str(out)
        assert result["file_size_kb"] > 0

        html = out.read_text(encoding="utf-8")
        assert len(html) > 500
        # Structural elements.
        assert "<svg" in html
        assert "eq-line" in html  # equity curve
        assert "dd-line" in html  # drawdown
        assert "MONTHLY" in html  # heatmap
        # Header grid labels.
        assert "EURUSD" in html
        assert "Win Rate" in html
        assert "Profit Factor" in html
        # Core performance table.
        assert "Sharpe Ratio" in html
        assert "Sortino Ratio" in html
        assert "Calmar Ratio" in html
        assert "Max Drawdown" in html
        # Validation card.
        assert "VALIDATION" in html
        assert "DSR" in html
        assert "PBO" in html
        assert "Degradation" in html

    def test_tearsheet_embeds_metric_values(self, tmp_path):
        df = synthetic_fx(n_bars=200)
        bt = run_backtest(df, MomentumStrategy(fast=5, slow=20))
        out = tmp_path / "ts2.html"
        generate_html_tearsheet(bt, output_path=out)
        html = out.read_text(encoding="utf-8")
        # Sharpe value from metrics should appear (4-decimal formatted).
        sharpe = bt.metrics["sharpe"]
        assert f"{sharpe:.4f}" in html

    def test_tearsheet_failed_validation_shown(self, tmp_path):
        df = synthetic_fx(n_bars=200)
        bt = run_backtest(df, MomentumStrategy(fast=5, slow=20))
        ev = _passed_evidence(
            passed=False,
            failure_reasons=["DSR 0.10 below threshold 0.95", "PBO 0.9 exceeds 0.5"],
        )
        out = tmp_path / "ts_fail.html"
        generate_html_tearsheet(bt, validation_evidence=ev, output_path=out)
        html = out.read_text(encoding="utf-8")
        assert "FAIL" in html
        assert "DSR 0.10" in html

    def test_tearsheet_no_external_deps(self, tmp_path):
        """No CDN links, no script tags, no external stylesheets."""
        df = synthetic_fx(n_bars=150)
        bt = run_backtest(df, MomentumStrategy(fast=5, slow=15))
        out = tmp_path / "ts_clean.html"
        generate_html_tearsheet(bt, output_path=out)
        html = out.read_text(encoding="utf-8").lower()
        assert "cdn" not in html
        assert "<script" not in html
        assert "<link" not in html
        assert "http" not in html

    def test_tearsheet_no_validation_evidence(self, tmp_path):
        df = synthetic_fx(n_bars=150)
        bt = run_backtest(df, MomentumStrategy(fast=5, slow=15))
        out = tmp_path / "ts_noval.html"
        result = generate_html_tearsheet(bt, validation_evidence=None, output_path=out)
        assert result["file_size_kb"] > 0
        html = out.read_text(encoding="utf-8")
        assert "No validation evidence" in html

    def test_tearsheet_short_equity(self, tmp_path):
        """Degenerate equity (single point) should not crash."""
        from primequant.backtest.engine import BacktestResult

        bt = BacktestResult(metrics={"sharpe": 0.0, "n_trades": 0}, equity=[10000.0])
        out = tmp_path / "ts_short.html"
        result = generate_html_tearsheet(bt, output_path=out)
        assert result["file_size_kb"] > 0
        html = out.read_text(encoding="utf-8")
        assert "Insufficient data" in html
