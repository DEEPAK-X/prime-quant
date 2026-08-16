"""High-level validation pipeline and gate.

``run_validation_pipeline`` is the single entry point that runs a strategy
through CPCV and walk-forward validation, then emits a strict boolean verdict.
When ``passed == False`` the returned evidence carries explicit failure
reasons so downstream optimization is blocked until the strategy clears the
gate.

The gate enforces the project's hard constraint: NO parameter optimization is
permitted until this pipeline returns ``passed == True``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Sequence

import polars as pl

from primequant.backtest.engine import BacktestConfig, run_backtest
from primequant.data.loader import CANON_TIME
from primequant.metrics.core import returns as equity_returns
from primequant.validate.cpcv import CPCVConfig, CPCVSplitter, Fold, split_summary
from primequant.validate.overfit import (
    deflated_sharpe_ratio,
    fold_consistency,
    is_oos_degradation,
    probability_of_backtest_overfitting,
)
from primequant.validate.walk_forward import (
    FitFn,
    WalkForwardConfig,
    run_walk_forward,
)
from primequant.strategy.base import Strategy


@dataclass(frozen=True)
class ValidationConfig:
    """Thresholds for the validation gate."""

    cpcv: CPCVConfig = field(default_factory=CPCVConfig)
    walk_forward: WalkForwardConfig = field(default_factory=WalkForwardConfig)
    backtest: BacktestConfig = field(default_factory=BacktestConfig)

    # Gate thresholds. A strategy must clear ALL of these.
    min_dsr: float = 0.95
    max_pbo: float = 0.5
    max_degradation_pct: float = 0.5
    min_positive_fold_rate: float = 0.5
    min_oos_sharpe: float = 0.0
    min_cpcv_folds: int = 6


@dataclass
class ValidationEvidence:
    passed: bool
    failure_reasons: list[str] = field(default_factory=list)
    cpcv_summary: dict = field(default_factory=dict)
    walk_forward_summary: dict = field(default_factory=dict)
    dsr: dict = field(default_factory=dict)
    pbo: dict = field(default_factory=dict)
    degradation: dict = field(default_factory=dict)
    fold_consistency: dict = field(default_factory=dict)
    oos_sharpe_mean: float = 0.0
    is_sharpe_mean: float = 0.0

    def to_summary(self) -> dict:
        """Compact JSON evidence summary - the only sanctioned output shape."""
        return {
            "passed": self.passed,
            "failure_reasons": self.failure_reasons,
            "oos_sharpe_mean": self.oos_sharpe_mean,
            "is_sharpe_mean": self.is_sharpe_mean,
            "cpcv": self.cpcv_summary,
            "walk_forward": self.walk_forward_summary,
            "dsr": self.dsr,
            "pbo": self.pbo,
            "degradation": self.degradation,
            "fold_consistency": self.fold_consistency,
        }


def _slice_by_idx(df: pl.DataFrame, idx: Sequence[int]) -> pl.DataFrame:
    if not idx:
        return df.head(0)
    rows = df.to_dicts()
    sub = [rows[i] for i in idx]
    return pl.DataFrame(sub, schema=df.schema)


def _strategy_sharpe(
    df: pl.DataFrame,
    strategy: Strategy,
    config: BacktestConfig,
    periods_per_year: int,
) -> float:
    """Annualized Sharpe of a strategy run on a frame (0 on degenerate input)."""
    if df.height == 0:
        return 0.0
    result = run_backtest(df, strategy, config=config)
    eq = result.equity
    if len(eq) < 2:
        return 0.0
    r = equity_returns(eq)
    if len(r) < 2 or max(abs(x) for x in r) == 0:
        return 0.0
    sd = (sum((x - (sum(r) / len(r))) ** 2 for x in r) / (len(r) - 1)) ** 0.5
    if sd == 0:
        return 0.0
    mean = sum(r) / len(r)
    import math
    return mean / sd * math.sqrt(periods_per_year)


def run_validation_pipeline(
    data: pl.DataFrame,
    strategy: Strategy,
    config: ValidationConfig | None = None,
    fit_fn: FitFn | None = None,
    *,
    trial_sharpes: Sequence[float] | None = None,
) -> ValidationEvidence:
    """Run CPCV + walk-forward validation and return a strict pass/fail gate.

    Parameters
    ----------
    data
        Full OHLCV frame, sorted ascending by time.
    strategy
        The candidate strategy to validate.
    config
        Validation thresholds. Defaults to ``ValidationConfig()``.
    fit_fn
        Optional per-window recalibration function for walk-forward
        (``fit_fn(train_df) -> Strategy``). If None, the same ``strategy`` is
        used for every walk-forward fold.
    trial_sharpes
        Annualized Sharpes of all trials considered during strategy selection,
        for the Deflated Sharpe Ratio. If None, only the candidate's own
        Sharpe is used (n_trials=1, minimal deflation).

    Returns
    -------
    ValidationEvidence
        ``passed`` is True only if every gate threshold is cleared. When
        False, ``failure_reasons`` lists each violated constraint so
        downstream optimization is explicitly blocked.
    """
    config = config or ValidationConfig()
    data = data.sort(CANON_TIME)
    ppy = config.backtest.periods_per_year

    # ---- CPCV ----
    splitter = CPCVSplitter(data.height, config.cpcv)
    folds: list[Fold] = list(splitter.split())

    is_sharpes_per_fold: list[list[float]] = []
    oos_sharpes_per_fold: list[list[float]] = []
    is_sharpes_flat: list[float] = []
    oos_sharpes_flat: list[float] = []
    # For PBO we need multiple strategies per fold. With a single candidate we
    # approximate by using the strategy and a flat-baseline (0 lots) so PBO has
    # a comparator; this keeps PBO meaningful for single-strategy validation.

    from primequant.strategy.base import FixedLotSizer, SignalResult, Strategy as Strat

    class _Flat(Strat):
        name = "_flat_baseline"

        def signals(self, df: pl.DataFrame) -> SignalResult:
            out = df.select(CANON_TIME).with_columns(pl.lit(0.0).alias("target_lots"))
            return SignalResult(df=out)

    baseline = _Flat()

    for fold in folds:
        train_df = _slice_by_idx(data, fold.train)
        test_df = _slice_by_idx(data, fold.test)
        if train_df.height == 0 or test_df.height == 0:
            continue
        # IS: candidate vs baseline on train.
        is_cand = _strategy_sharpe(train_df, strategy, config.backtest, ppy)
        is_base = _strategy_sharpe(train_df, baseline, config.backtest, ppy)
        # OOS: candidate vs baseline on test.
        oos_cand = _strategy_sharpe(test_df, strategy, config.backtest, ppy)
        oos_base = _strategy_sharpe(test_df, baseline, config.backtest, ppy)
        is_sharpes_per_fold.append([is_cand, is_base])
        oos_sharpes_per_fold.append([oos_cand, oos_base])
        is_sharpes_flat.append(is_cand)
        oos_sharpes_flat.append(oos_cand)

    cpcv_sum = split_summary(folds)

    # ---- Walk-forward ----
    wf_fit = fit_fn or (lambda _train_df: strategy)
    wf_result = run_walk_forward(
        data, wf_fit, config=config.walk_forward, backtest_config=config.backtest
    )
    wf_sharpes = wf_result.oos_sharpes
    wf_summary = wf_result.to_summary()

    # Combine OOS Sharpes from CPCV + walk-forward for stability stats.
    all_oos = oos_sharpes_flat + wf_sharpes
    consistency = fold_consistency(all_oos)
    oos_mean = (sum(all_oos) / len(all_oos)) if all_oos else 0.0
    is_mean = (sum(is_sharpes_flat) / len(is_sharpes_flat)) if is_sharpes_flat else 0.0

    # ---- DSR ----
    # Use the candidate's full-data returns as the observed series.
    full_result = run_backtest(data, strategy, config=config.backtest)
    full_returns = equity_returns(full_result.equity)
    trials = list(trial_sharpes) if trial_sharpes is not None else [oos_mean or is_mean]
    dsr = deflated_sharpe_ratio(full_returns, trials, periods_per_year=ppy)

    # ---- PBO ----
    pbo = probability_of_backtest_overfitting(is_sharpes_per_fold, oos_sharpes_per_fold)

    # ---- Degradation ----
    deg = is_oos_degradation(is_sharpes_flat, oos_sharpes_flat)

    # ---- Gate ----
    reasons: list[str] = []
    if len(folds) < config.min_cpcv_folds:
        reasons.append(
            f"insufficient CPCV folds: {len(folds)} < {config.min_cpcv_folds}"
        )
    if dsr.dsr < config.min_dsr:
        reasons.append(
            f"DSR {dsr.dsr:.3f} below threshold {config.min_dsr:.3f}"
        )
    if pbo.pbo > config.max_pbo:
        reasons.append(
            f"PBO {pbo.pbo:.3f} exceeds threshold {config.max_pbo:.3f}"
        )
    if deg.degradation_pct > config.max_degradation_pct:
        reasons.append(
            f"IS/OOS degradation {deg.degradation_pct:.1%} exceeds "
            f"{config.max_degradation_pct:.0%}"
        )
    if consistency["positive_fold_rate"] < config.min_positive_fold_rate:
        reasons.append(
            f"positive fold rate {consistency['positive_fold_rate']:.1%} "
            f"below {config.min_positive_fold_rate:.0%}"
        )
    if oos_mean < config.min_oos_sharpe:
        reasons.append(
            f"OOS Sharpe {oos_mean:.3f} below {config.min_oos_sharpe:.3f}"
        )

    evidence = ValidationEvidence(
        passed=(len(reasons) == 0),
        failure_reasons=reasons,
        cpcv_summary=cpcv_sum,
        walk_forward_summary=wf_summary,
        dsr=dsr.to_dict(),
        pbo=pbo.to_dict(),
        degradation=deg.to_dict(),
        fold_consistency=consistency,
        oos_sharpe_mean=float(oos_mean),
        is_sharpe_mean=float(is_mean),
    )
    return evidence


def assert_passes(evidence: ValidationEvidence) -> None:
    """Raise ``ValidationGateError`` if the evidence did not pass the gate.

    Use this to hard-block optimization entry points.
    """

    if not evidence.passed:
        raise ValidationGateError(evidence)


class ValidationGateError(Exception):
    """Raised when a strategy fails the validation gate."""

    def __init__(self, evidence: ValidationEvidence):
        self.evidence = evidence
        reasons = "; ".join(evidence.failure_reasons)
        super().__init__(f"validation gate failed: {reasons}")
