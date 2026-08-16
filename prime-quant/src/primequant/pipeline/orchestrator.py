"""Strategy pipeline orchestrator.

Runs the full sequence: data ingestion + QA -> AST lookahead lint -> baseline
backtest -> validation gate -> conditional optimization -> tearsheet export.

Each step guards the next. A failed AST lint or a failed validation gate
short-circuits the pipeline: no optimization, no tearsheet, and an explicit
failure reason in the returned ``PipelineResult``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import polars as pl

from primequant.backtest.engine import BacktestConfig, BacktestResult, run_backtest
from primequant.data.loader import CANON_TIME, load_ohlcv
from primequant.optimize.engine import (
    OptimizationConfig,
    OptimizationResult,
    run_optimization,
)
from primequant.optimize.schema import ParamSpace
from primequant.report.tearsheet import generate_html_tearsheet
from primequant.strategy.base import Strategy
from primequant.validate.ast_linter import LintResult, lint_strategy_cls
from primequant.validate.pipeline import (
    ValidationConfig,
    ValidationEvidence,
    run_validation_pipeline,
)

StrategyFactory = Callable[[dict[str, Any]], Strategy]


@dataclass(frozen=True)
class PipelineConfig:
    """Pipeline configuration."""

    backtest: BacktestConfig = field(default_factory=BacktestConfig)
    validation: ValidationConfig = field(default_factory=ValidationConfig)
    optimization: OptimizationConfig = field(default_factory=OptimizationConfig)
    generate_report: bool = True
    report_path: str | None = None
    skip_ast_lint: bool = False
    # If True, run optimization even when param_space is provided but the
    # baseline already passes; default honors the gate strictly.


@dataclass
class PipelineResult:
    """Compact pipeline output - JSON-serializable, no raw frames."""

    completed: bool
    passed: bool
    blocked_reason: str | None = None
    qa_summary: dict = field(default_factory=dict)
    lint_summary: dict = field(default_factory=dict)
    backtest_summary: dict = field(default_factory=dict)
    validation_summary: dict = field(default_factory=dict)
    optimization_summary: dict = field(default_factory=dict)
    report: dict = field(default_factory=dict)

    def to_summary(self) -> dict:
        """The only sanctioned output shape - compact JSON dict."""
        return {
            "completed": self.completed,
            "passed": self.passed,
            "blocked_reason": self.blocked_reason,
            "qa": self.qa_summary,
            "lint": self.lint_summary,
            "backtest": self.backtest_summary,
            "validation": self.validation_summary,
            "optimization": self.optimization_summary,
            "report": self.report,
        }


def _strategy_factory_from_cls(
    strategy_cls: type[Strategy],
) -> StrategyFactory:
    """Build a factory that passes suggested params to the strategy ctor.

    Assumes the strategy class accepts its parameter names as kwargs (the
    standard pattern, e.g. ``MomentumStrategy(fast=..., slow=...)``).
    """
    def factory(params: dict[str, Any]) -> Strategy:
        return strategy_cls(**params)

    return factory


def run_quant_pipeline(
    strategy_cls: type[Strategy],
    data_path: str | Path,
    config: PipelineConfig | None = None,
    param_space: ParamSpace | None = None,
    generate_report: bool | None = None,
) -> PipelineResult:
    """Run the full quant pipeline.

    Steps:
      1. Data ingestion + QA (monotonicity, gaps, spread health).
      2. Pre-execution AST lint (t+1 lookahead, global normalization).
      3. Baseline backtest.
      4. Validation gate (CPCV + walk-forward).
      5. Conditional optimization (only if validation passes AND param_space
         is provided).
      6. Tearsheet export.

    Returns a ``PipelineResult`` with ``completed``, ``passed``, and
    ``blocked_reason``. If any gate fails, downstream steps are skipped and the
    reason is recorded.
    """
    config = config or PipelineConfig()
    do_report = generate_report if generate_report is not None else config.generate_report

    # ---- Step 1: Data ingestion & QA ----
    try:
        df, qa = load_ohlcv(data_path)
    except Exception as e:
        return PipelineResult(
            completed=False,
            passed=False,
            blocked_reason=f"data ingestion failed: {e}",
        )

    qa_summary = qa.to_summary()
    if qa.has_errors:
        return PipelineResult(
            completed=False,
            passed=False,
            blocked_reason=f"QA errors: {[i.message for i in qa.issues if i.severity == 'error']}",
            qa_summary=qa_summary,
        )

    # ---- Step 2: Pre-execution AST lint ----
    lint_result: LintResult
    if config.skip_ast_lint:
        lint_result = LintResult()
    else:
        lint_result = lint_strategy_cls(strategy_cls)
    lint_summary = lint_result.to_summary()

    if lint_result.has_errors:
        msgs = "; ".join(i.message for i in lint_result.issues if i.severity == "error")
        return PipelineResult(
            completed=False,
            passed=False,
            blocked_reason=f"AST lint blocked strategy: {msgs}",
            qa_summary=qa_summary,
            lint_summary=lint_summary,
        )

    # ---- Step 3: Baseline backtest ----
    strategy = strategy_cls()
    try:
        bt: BacktestResult = run_backtest(df, strategy, config=config.backtest)
    except Exception as e:
        return PipelineResult(
            completed=False,
            passed=False,
            blocked_reason=f"baseline backtest failed: {e}",
            qa_summary=qa_summary,
            lint_summary=lint_summary,
        )
    bt_summary = bt.to_summary()

    # ---- Step 4: Validation gate ----
    try:
        evidence: ValidationEvidence = run_validation_pipeline(
            df, strategy, config=config.validation
        )
    except Exception as e:
        return PipelineResult(
            completed=False,
            passed=False,
            blocked_reason=f"validation pipeline failed: {e}",
            qa_summary=qa_summary,
            lint_summary=lint_summary,
            backtest_summary=bt_summary,
        )
    val_summary = evidence.to_summary()

    # If validation fails, skip optimization. Tearsheet still generated if
    # requested (it will show the FAIL state).
    opt_summary: dict = {}
    if not evidence.passed:
        report = {}
        if do_report:
            try:
                report = generate_html_tearsheet(
                    bt,
                    validation_evidence=evidence,
                    output_path=config.report_path,
                )
            except Exception as e:
                report = {"error": str(e)}
        return PipelineResult(
            completed=True,
            passed=False,
            blocked_reason=(
                f"validation gate failed: {'; '.join(evidence.failure_reasons)}"
            ),
            qa_summary=qa_summary,
            lint_summary=lint_summary,
            backtest_summary=bt_summary,
            validation_summary=val_summary,
            optimization_summary=opt_summary,
            report=report,
        )

    # ---- Step 5: Conditional optimization ----
    if param_space is not None:
        try:
            factory = _strategy_factory_from_cls(strategy_cls)
            opt_result: OptimizationResult = run_optimization(
                strategy_factory=factory,
                data=df,
                param_space=param_space,
                config=config.optimization,
                baseline_evidence=evidence,
            )
            opt_summary = opt_result.to_summary()
        except Exception as e:
            opt_summary = {"error": f"optimization failed: {e}"}

    # ---- Step 6: Tearsheet export ----
    report = {}
    if do_report:
        try:
            report = generate_html_tearsheet(
                bt,
                validation_evidence=evidence,
                output_path=config.report_path,
            )
        except Exception as e:
            report = {"error": str(e)}

    return PipelineResult(
        completed=True,
        passed=True,
        blocked_reason=None,
        qa_summary=qa_summary,
        lint_summary=lint_summary,
        backtest_summary=bt_summary,
        validation_summary=val_summary,
        optimization_summary=opt_summary,
        report=report,
    )
