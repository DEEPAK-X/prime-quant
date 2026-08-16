"""Overfit-gated Bayesian parameter optimizer.

Wraps Optuna's TPE sampler with two hard anti-overfit controls:

  1. Validation gate: the optimizer will not run a single trial until a
     ``ValidationEvidence`` with ``passed == True`` is supplied. This enforces
     the project's hard constraint that no optimization is permitted until the
     baseline strategy has cleared CPCV + walk-forward validation.

  2. DSR-penalized objective: instead of maximizing raw in-sample Sharpe,
     each trial's Sharpe is deflated by the running count and variance of all
     prior trial Sharpes via ``deflated_sharpe_ratio``. Brute-force parameter
     mining is therefore self-defeating: the more trials you run, the higher
     the hurdle.

The objective returns the DSR (a [0,1] probability that the observed Sharpe
beats the expected max under the selection-bias null) so Optuna maximizes the
*deflated* edge, not the headline number. Median/Hyperband pruners kill
unpromising trials early.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Any

import polars as pl

from primequant.backtest.engine import BacktestConfig, run_backtest
from primequant.data.loader import CANON_TIME
from primequant.metrics.core import returns as equity_returns
from primequant.optimize.schema import ParamSpace
from primequant.strategy.base import Strategy
from primequant.validate.overfit import deflated_sharpe_ratio
from primequant.validate.pipeline import (
    ValidationConfig,
    ValidationEvidence,
    ValidationGateError,
    assert_passes,
)
from primequant.validate.walk_forward import (
    WalkForwardConfig,
    run_walk_forward,
)

# A factory builds a strategy instance from a {param: value} dict. This keeps
# strategies free of any optimizer coupling.
StrategyFactory = Callable[[dict[str, Any]], Strategy]


@dataclass(frozen=True)
class OptimizationConfig:
    """Optimizer configuration."""

    n_trials: int = 25
    timeout_seconds: float | None = None
    backtest: BacktestConfig = field(default_factory=BacktestConfig)
    walk_forward: WalkForwardConfig = field(default_factory=WalkForwardConfig)
    validation: ValidationConfig = field(default_factory=ValidationConfig)
    pruner_type: str = "median"  # "median" | "hyperband" | "none"
    seed: int = 42
    # IS/OOS split for the objective: the optimizer fits on the first
    # ``in_sample_frac`` of data and scores stability on the held-out tail.
    in_sample_frac: float = 0.6


@dataclass
class CandidateResult:
    """A single optimized candidate."""

    params: dict[str, Any]
    is_sharpe: float
    oos_sharpe: float
    dsr: float
    n_trials_at_eval: int
    stability: float  # min(IS, OOS) / max(IS, OOS), 1.0 = perfectly stable

    def to_dict(self) -> dict:
        return {
            "params": dict(self.params),
            "is_sharpe": self.is_sharpe,
            "oos_sharpe": self.oos_sharpe,
            "dsr": self.dsr,
            "n_trials_at_eval": self.n_trials_at_eval,
            "stability": self.stability,
        }


@dataclass
class OptimizationResult:
    """Final optimizer output - compact, no raw frames."""

    best: CandidateResult
    top_candidates: list[CandidateResult]
    n_trials_run: int
    trial_sharpes: list[float]
    final_dsr: float
    completed: bool

    def to_summary(self) -> dict:
        """Compact JSON summary - the only sanctioned output shape."""
        return {
            "best": self.best.to_dict(),
            "top_candidates": [c.to_dict() for c in self.top_candidates],
            "n_trials_run": self.n_trials_run,
            "n_total_sharpes": len(self.trial_sharpes),
            "final_dsr": self.final_dsr,
            "completed": self.completed,
        }


class OptimizationEngine:
    """Bayesian (TPE) parameter optimizer with DSR penalty and validation gate.

    The engine holds the mutable trial history so the DSR objective can see
    every prior trial's Sharpe as the search progresses. State is per-engine
    instance; create a fresh engine per optimization run.
    """

    def __init__(
        self,
        data: pl.DataFrame,
        strategy_factory: StrategyFactory,
        param_space: ParamSpace,
        config: OptimizationConfig | None = None,
    ):
        self.data = data.sort(CANON_TIME)
        self.strategy_factory = strategy_factory
        self.param_space = param_space
        self.config = config or OptimizationConfig()
        self._trial_sharpes: list[float] = []
        self._trial_records: list[CandidateResult] = []
        self._is_frame: pl.DataFrame
        self._oos_frame: pl.DataFrame
        self._split_data()

    def _split_data(self) -> None:
        n = self.data.height
        split = int(n * self.config.in_sample_frac)
        rows = self.data.to_dicts()
        self._is_frame = pl.DataFrame(rows[:split], schema=self.data.schema)
        self._oos_frame = pl.DataFrame(rows[split:], schema=self.data.schema)

    @property
    def trial_sharpes(self) -> list[float]:
        return list(self._trial_sharpes)

    def _build_pruner(self) -> Any:
        from optuna.pruners import MedianPruner, HyperbandPruner, NopPruner

        kind = self.config.pruner_type.lower()
        if kind == "median":
            return MedianPruner(n_startup_trials=3, n_warmup_steps=2)
        if kind == "hyperband":
            return HyperbandPruner(min_resource=2, max_resource=self.config.n_trials)
        return NopPruner()

    def _objective(self, trial: Any) -> float:
        """DSR-penalized objective.

        Suggests params, builds a strategy, backtests on the IS split, and
        returns the DSR computed against the running history of trial
        Sharpes. A higher trial count inflates the expected-max Sharpe null,
        so identical raw performance yields a lower DSR as the search grows.
        """
        params = self.param_space.suggest(trial)
        strategy = self.strategy_factory(params)

        is_result = run_backtest(
            self._is_frame, strategy, config=self.config.backtest
        )
        is_sharpe = float(is_result.metrics.get("sharpe", 0.0))

        # Track the trial Sharpe for DSR deflation of *this* and future trials.
        self._trial_sharpes.append(is_sharpe)
        n_at_eval = len(self._trial_sharpes)

        # DSR: observed = this trial's returns, trials = all Sharpes so far.
        is_returns = equity_returns(is_result.equity)
        dsr_result = deflated_sharpe_ratio(
            is_returns,
            self._trial_sharpes,
            periods_per_year=self.config.backtest.periods_per_year,
        )
        dsr = float(dsr_result.dsr)

        # OOS stability score on the held-out tail (no fitting here).
        try:
            oos_result = run_backtest(
                self._oos_frame, strategy, config=self.config.backtest
            )
            oos_sharpe = float(oos_result.metrics.get("sharpe", 0.0))
        except Exception:
            oos_sharpe = 0.0

        lo = min(is_sharpe, oos_sharpe)
        hi = max(abs(is_sharpe), abs(oos_sharpe), 1e-9)
        stability = lo / hi if hi > 0 else 0.0

        self._trial_records.append(
            CandidateResult(
                params=dict(params),
                is_sharpe=is_sharpe,
                oos_sharpe=oos_sharpe,
                dsr=dsr,
                n_trials_at_eval=n_at_eval,
                stability=float(stability),
            )
        )

        # Report intermediate for pruning.
        trial.report(dsr, step=n_at_eval)
        if trial.should_prune():
            from optuna import TrialPruned

            raise TrialPruned()

        return dsr

    def optimize(self, baseline_evidence: ValidationEvidence) -> OptimizationResult:
        """Run the TPE search. Requires a passed validation gate.

        Raises ``ValidationGateError`` if ``baseline_evidence.passed`` is
        False - this physically blocks trial generation before Optuna is even
        constructed.
        """
        # HARD GATE: block before any optimization begins.
        assert_passes(baseline_evidence)

        import optuna

        optuna.logging.set_verbosity(optuna.logging.WARNING)
        sampler = optuna.samplers.TPESampler(seed=self.config.seed)
        pruner = self._build_pruner()
        study = optuna.create_study(
            direction="maximize",
            sampler=sampler,
            pruner=pruner,
        )

        completed = True
        try:
            study.optimize(
                self._objective,
                n_trials=self.config.n_trials,
                timeout=self.config.timeout_seconds,
                catch=(Exception,),
            )
        except Exception:
            completed = False

        # Rank candidates by DSR (the objective we maximized).
        ranked = sorted(self._trial_records, key=lambda c: c.dsr, reverse=True)
        if not ranked:
            # All trials pruned/failed; synthesize an empty result.
            empty = CandidateResult({}, 0.0, 0.0, 0.0, 0, 0.0)
            return OptimizationResult(
                best=empty,
                top_candidates=[],
                n_trials_run=0,
                trial_sharpes=[],
                final_dsr=0.0,
                completed=completed,
            )

        final_dsr = ranked[0].dsr
        return OptimizationResult(
            best=ranked[0],
            top_candidates=ranked[: min(5, len(ranked))],
            n_trials_run=len(self._trial_records),
            trial_sharpes=list(self._trial_sharpes),
            final_dsr=float(final_dsr),
            completed=completed,
        )


def run_optimization(
    strategy_factory: StrategyFactory,
    data: pl.DataFrame,
    param_space: ParamSpace,
    config: OptimizationConfig | None,
    baseline_evidence: ValidationEvidence,
) -> OptimizationResult:
    """Primary entry point: optimize strategy params behind the validation gate.

    Parameters
    ----------
    strategy_factory
        Callable mapping a {param: value} dict to a ``Strategy`` instance.
    data
        Full OHLCV frame, sorted ascending by time.
    param_space
        Declarative parameter definitions (``IntParam``/``FloatParam``/
        ``CategoricalParam``) wrapped in a ``ParamSpace``.
    config
        Optimizer configuration (trials, timeout, pruner, IS/OOS split).
    baseline_evidence
        A ``ValidationEvidence`` from ``run_validation_pipeline``. MUST have
        ``passed == True`` or a ``ValidationGateError`` is raised and no trial
        is generated.

    Returns
    -------
    OptimizationResult
        Compact summary: best params, IS/OOS Sharpes, final DSR, stability,
        trial history. No raw DataFrames.
    """
    if baseline_evidence.passed is False:
        # Explicit hard block with the exact reasons from the validation gate.
        raise ValidationGateError(baseline_evidence)

    config = config or OptimizationConfig()
    engine = OptimizationEngine(
        data=data,
        strategy_factory=strategy_factory,
        param_space=param_space,
        config=config,
    )
    return engine.optimize(baseline_evidence)
