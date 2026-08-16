"""Tests for the strategy pipeline orchestrator."""

from __future__ import annotations

import json
from pathlib import Path

import polars as pl
import pytest

from primequant.optimize import IntParam, OptimizationConfig, ParamSpace
from primequant.optimize.schema import ParamSpace as PS
from primequant.pipeline.orchestrator import (
    PipelineConfig,
    run_quant_pipeline,
)
from primequant.strategy.base import MomentumStrategy, SignalResult, Strategy
from primequant.validate import CPCVConfig, ValidationConfig
from primequant.validate.pipeline import ValidationEvidence
from primequant.validate.walk_forward import WalkForwardConfig
from tests._fxdata import synthetic_fx


@pytest.fixture
def fx_csv(tmp_path) -> Path:
    """Write synthetic EURUSD OHLCV to a CSV for the pipeline to ingest."""
    df = synthetic_fx(n_bars=400, drift=0.00005, vol=0.0001, seed=21)
    out = tmp_path / "eurusd_1h.csv"
    df.write_csv(out)
    return out


class TestPipelineEndToEnd:
    def test_pipeline_end_to_end_pass(self, fx_csv, tmp_path):
        """Full pipeline on synthetic FX trend data through backtest,
        validation, and report generation."""
        cfg = PipelineConfig(
            validation=ValidationConfig(
                cpcv=CPCVConfig(n_groups=6, n_test_groups=2, embargo_bars=2),
                walk_forward=WalkForwardConfig(train_bars=150, test_bars=50),
                # Relaxed thresholds for synthetic trend data to clear.
                min_dsr=0.0,
                max_pbo=1.0,
                max_degradation_pct=2.0,
                min_positive_fold_rate=0.3,
                min_oos_sharpe=-1.0,
                min_cpcv_folds=6,
            ),
            report_path=str(tmp_path / "report.html"),
        )

        result = run_quant_pipeline(
            strategy_cls=MomentumStrategy,
            data_path=fx_csv,
            config=cfg,
            param_space=ParamSpace(
                [IntParam("fast", low=2, high=10), IntParam("slow", low=10, high=25)]
            ),
            generate_report=True,
        )

        s = result.to_summary()
        # JSON-serializable (no raw frames).
        json.dumps(s)

        assert result.completed is True
        assert result.passed is True
        assert result.blocked_reason is None
        # QA ran.
        assert "ok" in s["qa"]
        assert s["qa"]["ok"] is True
        # Lint ran (MomentumStrategy source is clean).
        assert s["lint"]["ok"] is True
        # Backtest ran.
        assert "sharpe" in s["backtest"]
        # Validation ran.
        assert s["validation"]["passed"] is True
        # Optimization ran (param_space provided).
        assert s["optimization"] != {}
        # Report generated.
        assert s["report"]["report_path"] == str(tmp_path / "report.html")
        assert s["report"]["file_size_kb"] > 0

    def test_pipeline_skips_optimization_when_validation_fails(self, fx_csv, tmp_path):
        """When validation fails, optimization must be skipped."""
        cfg = PipelineConfig(
            validation=ValidationConfig(
                cpcv=CPCVConfig(n_groups=6, n_test_groups=2, embargo_bars=2),
                walk_forward=WalkForwardConfig(train_bars=150, test_bars=50),
                # Strict thresholds that synthetic data won't clear.
                min_dsr=0.99,
                max_pbo=0.1,
                max_degradation_pct=0.05,
                min_positive_fold_rate=0.99,
                min_oos_sharpe=5.0,
                min_cpcv_folds=6,
            ),
            report_path=str(tmp_path / "report.html"),
        )

        result = run_quant_pipeline(
            strategy_cls=MomentumStrategy,
            data_path=fx_csv,
            config=cfg,
            param_space=ParamSpace([IntParam("fast", 2, 8)]),
        )

        # Validation gate fails -> optimization skipped.
        assert result.passed is False
        assert result.blocked_reason is not None
        assert "validation" in result.blocked_reason.lower()
        assert result.optimization_summary == {}


class TestPipelineBlocksBadStrategy:
    def test_pipeline_blocks_bad_strategy(self, fx_csv):
        """An overfit/lookahead-biased strategy is blocked before tearsheet
        and optimization."""

        class LookaheadStrategy(Strategy):
            """Uses .shift(-1) to read future bars - invalid lookahead."""

            name = "lookahead_bad"

            def signals(self, df: pl.DataFrame) -> SignalResult:
                fut = df["close"].shift(-1)
                sig = (fut > df["close"]).cast(pl.Float64)
                out = df.with_columns(sig.alias("target_lots"))
                return SignalResult(df=out.select("time", "target_lots"))

        result = run_quant_pipeline(
            strategy_cls=LookaheadStrategy,
            data_path=fx_csv,
            config=PipelineConfig(),
        )
        s = result.to_summary()

        # Blocked by AST lint before backtest/optimization/tearsheet.
        assert result.completed is False
        assert result.passed is False
        assert result.blocked_reason is not None
        assert "AST lint" in result.blocked_reason
        # No backtest, no validation, no optimization, no report.
        assert s["backtest"] == {}
        assert s["validation"] == {}
        assert s["optimization"] == {}
        assert s["report"] == {}

    def test_pipeline_blocks_global_normalization(self, fx_csv):
        """A strategy that fits a scaler over the full frame is blocked."""

        class GlobalNormStrategy(Strategy):
            name = "global_norm_bad"

            def signals(self, df: pl.DataFrame) -> SignalResult:
                # This is a static red-flag: a scaler.fit_transform call in
                # source, even if not executed, should be caught by the linter.
                # We embed it in a method that returns early so it's parseable.
                if False:
                    from sklearn.preprocessing import StandardScaler

                    StandardScaler().fit_transform(df)
                out = df.select("time").with_columns(
                    pl.lit(0.0).alias("target_lots")
                )
                return SignalResult(df=out)

        result = run_quant_pipeline(
            strategy_cls=GlobalNormStrategy,
            data_path=fx_csv,
            config=PipelineConfig(),
        )
        # The linter should flag the fit_transform call.
        assert result.completed is False
        assert result.passed is False
        assert result.blocked_reason is not None
        assert "AST lint" in result.blocked_reason


class TestPipelineDataIngestion:
    def test_pipeline_blocks_on_qa_errors(self, tmp_path):
        """Missing required columns -> QA error -> pipeline blocked."""
        # CSV without the required OHLCV columns.
        bad = tmp_path / "bad.csv"
        pl.DataFrame({"foo": [1, 2, 3]}).write_csv(bad)
        result = run_quant_pipeline(
            strategy_cls=MomentumStrategy,
            data_path=bad,
            config=PipelineConfig(),
        )
        assert result.completed is False
        assert result.passed is False
        assert result.blocked_reason is not None

    def test_pipeline_blocks_missing_file(self, tmp_path):
        result = run_quant_pipeline(
            strategy_cls=MomentumStrategy,
            data_path=tmp_path / "nonexistent.csv",
            config=PipelineConfig(),
        )
        assert result.completed is False
        assert result.passed is False
        assert "ingestion" in result.blocked_reason.lower()


class TestPipelineResultShape:
    def test_summary_keys(self, fx_csv):
        result = run_quant_pipeline(
            strategy_cls=MomentumStrategy,
            data_path=fx_csv,
            config=PipelineConfig(generate_report=False),
        )
        s = result.to_summary()
        for key in (
            "completed",
            "passed",
            "blocked_reason",
            "qa",
            "lint",
            "backtest",
            "validation",
            "optimization",
            "report",
        ):
            assert key in s
