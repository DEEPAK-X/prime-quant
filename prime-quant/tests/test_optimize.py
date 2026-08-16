"""Tests for the overfit-gated parameter optimizer."""

from __future__ import annotations

import pytest

import polars as pl

from primequant.optimize import (
    CategoricalParam,
    FloatParam,
    IntParam,
    OptimizationConfig,
    ParamSpace,
    run_optimization,
)
from primequant.optimize.engine import OptimizationEngine
from primequant.strategy.base import MomentumStrategy, Strategy
from primequant.validate import ValidationConfig
from primequant.validate.pipeline import (
    ValidationEvidence,
    ValidationGateError,
)
from tests._fxdata import synthetic_fx


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _passed_evidence(**overrides) -> ValidationEvidence:
    """Construct a passing ValidationEvidence for gate tests."""
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


def _failed_evidence() -> ValidationEvidence:
    return _passed_evidence(
        passed=False,
        failure_reasons=["DSR 0.10 below threshold 0.95", "PBO 0.9 exceeds 0.5"],
    )


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class TestParamSpace:
    def test_int_param_suggests_int(self):
        import optuna

        study = optuna.create_study()
        space = ParamSpace([IntParam("x", low=2, high=10)])
        trial = study.ask()
        val = space.suggest(trial)
        assert isinstance(val["x"], int)
        assert 2 <= val["x"] <= 10

    def test_float_param_log(self):
        import optuna

        study = optuna.create_study()
        space = ParamSpace([FloatParam("lr", low=1e-4, high=1e-1, log=True)])
        trial = study.ask()
        val = space.suggest(trial)
        assert 1e-4 <= val["lr"] <= 1e-1

    def test_categorical_param(self):
        import optuna

        study = optuna.create_study()
        space = ParamSpace([CategoricalParam("mode", choices=["a", "b", "c"])])
        trial = study.ask()
        val = space.suggest(trial)
        assert val["mode"] in {"a", "b", "c"}

    def test_param_space_names_and_len(self):
        space = ParamSpace(
            [IntParam("a", 1, 5), FloatParam("b", 0.0, 1.0), CategoricalParam("c", ["x"])]
        )
        assert space.names == ["a", "b", "c"]
        assert len(space) == 3


# ---------------------------------------------------------------------------
# Test 1: optimization blocked on failed validation
# ---------------------------------------------------------------------------

class TestGateEnforcement:
    def test_optimization_blocked_on_failed_validation(self):
        """The optimizer MUST raise before generating any trial when the
        baseline evidence has passed == False."""
        df = synthetic_fx(n_bars=200)
        param_space = ParamSpace(
            [IntParam("fast", low=2, high=10), IntParam("slow", low=10, high=30)]
        )

        factory = lambda p: MomentumStrategy(fast=p["fast"], slow=p["slow"])
        failed = _failed_evidence()
        assert failed.passed is False

        with pytest.raises(ValidationGateError):
            run_optimization(
                strategy_factory=factory,
                data=df,
                param_space=param_space,
                config=OptimizationConfig(n_trials=5),
                baseline_evidence=failed,
            )

    def test_gate_blocked_before_engine_constructs_trials(self):
        """Even the lower-level engine.optimize() must hard-block."""
        df = synthetic_fx(n_bars=200)
        param_space = ParamSpace([IntParam("fast", 2, 10)])
        factory = lambda p: MomentumStrategy(fast=p["fast"], slow=20)
        engine = OptimizationEngine(
            data=df,
            strategy_factory=factory,
            param_space=param_space,
            config=OptimizationConfig(n_trials=3),
        )
        with pytest.raises(ValidationGateError):
            engine.optimize(_failed_evidence())
        # No trials recorded because the gate fired first.
        assert engine.trial_sharpes == []

    def test_passing_evidence_allows_optimization(self):
        df = synthetic_fx(n_bars=200)
        param_space = ParamSpace(
            [IntParam("fast", low=2, high=8), IntParam("slow", low=10, high=25)]
        )
        factory = lambda p: MomentumStrategy(fast=p["fast"], slow=p["slow"])
        result = run_optimization(
            strategy_factory=factory,
            data=df,
            param_space=param_space,
            config=OptimizationConfig(n_trials=5),
            baseline_evidence=_passed_evidence(),
        )
        assert result.n_trials_run > 0
        assert result.best.params  # non-empty


# ---------------------------------------------------------------------------
# Test 2: DSR penalty scales with trial count
# ---------------------------------------------------------------------------

class TestDSRPenalty:
    def test_dsr_penalty_scaling_with_trials(self):
        """Running more trials increases the hurdle and decreases DSR for
        identical raw returns.

        We construct an engine, manually feed identical-Sharpe trial results
        into the DSR computation at two trial counts, and verify the larger
        trial count yields a lower (or equal) DSR.
        """
        from primequant.validate.overfit import deflated_sharpe_ratio

        import random as _r

        rng = _r.Random(5)
        # Identical observed returns for both scenarios.
        observed = [0.001 + rng.gauss(0, 0.0002) for _ in range(200)]

        # Scenario A: few trials, similar Sharpes.
        few_trial_sharpes = [2.0, 2.1, 1.9]
        # Scenario B: many trials, same Sharpe population -> more selection
        # bias -> higher expected-max null -> lower DSR.
        many_trial_sharpes = [2.0, 2.1, 1.9] * 20  # 60 trials

        dsr_few = deflated_sharpe_ratio(observed, few_trial_sharpes)
        dsr_many = deflated_sharpe_ratio(observed, many_trial_sharpes)
        assert dsr_many.dsr <= dsr_few.dsr
        assert dsr_many.n_trials > dsr_few.n_trials

    def test_engine_tracks_trial_sharpes(self):
        """The engine records every trial Sharpe so DSR accumulates."""
        df = synthetic_fx(n_bars=200)
        param_space = ParamSpace([IntParam("fast", 2, 8)])
        factory = lambda p: MomentumStrategy(fast=p["fast"], slow=20)
        engine = OptimizationEngine(
            data=df,
            strategy_factory=factory,
            param_space=param_space,
            config=OptimizationConfig(n_trials=5, pruner_type="none"),
        )
        result = engine.optimize(_passed_evidence())
        assert len(engine.trial_sharpes) == result.n_trials_run
        # Trial count at the last candidate equals total trials run.
        if result.top_candidates:
            assert result.best.n_trials_at_eval <= result.n_trials_run


# ---------------------------------------------------------------------------
# Test 3: parameter optimization on momentum
# ---------------------------------------------------------------------------

class TestParameterOptimization:
    def test_parameter_optimization_momentum(self):
        """20-trial TPE search over fast/slow SMA periods on synthetic
        EURUSD. Must return a valid best candidate with both params set."""
        df = synthetic_fx(n_bars=400, drift=0.00005, vol=0.0001, seed=11)
        param_space = ParamSpace(
            [
                IntParam("fast", low=2, high=20),
                IntParam("slow", low=10, high=40),
            ]
        )

        def factory(p):
            # Enforce fast < slow for a sane SMA crossover.
            fast = min(p["fast"], p["slow"] - 1)
            slow = p["slow"]
            return MomentumStrategy(fast=fast, slow=slow)

        result = run_optimization(
            strategy_factory=factory,
            data=df,
            param_space=param_space,
            config=OptimizationConfig(n_trials=20, pruner_type="median", seed=42),
            baseline_evidence=_passed_evidence(),
        )
        s = result.to_summary()
        # Completed with the requested trial budget (allowing for pruning).
        assert result.n_trials_run > 0
        assert result.n_trials_run <= 20
        # Best candidate carries both params.
        assert "fast" in s["best"]["params"]
        assert "slow" in s["best"]["params"]
        # IS and OOS Sharpe fields present.
        assert isinstance(s["best"]["is_sharpe"], float)
        assert isinstance(s["best"]["oos_sharpe"], float)
        # DSR is in [0, 1].
        assert 0.0 <= s["best"]["dsr"] <= 1.0
        # No raw frames in the summary - only primitives and dicts.
        assert isinstance(s["top_candidates"], list)

    def test_summary_has_no_raw_dataframes(self):
        df = synthetic_fx(n_bars=200)
        param_space = ParamSpace([IntParam("fast", 2, 8)])
        factory = lambda p: MomentumStrategy(fast=p["fast"], slow=20)
        result = run_optimization(
            strategy_factory=factory,
            data=df,
            param_space=param_space,
            config=OptimizationConfig(n_trials=4, pruner_type="none"),
            baseline_evidence=_passed_evidence(),
        )
        s = result.to_summary()
        # Recursively ensure no polars/numpy frame leaks into the summary.
        import json

        json.dumps(s)  # serializable => no frames

    def test_timeout_config_respected(self):
        """A zero timeout should complete without raising."""
        df = synthetic_fx(n_bars=150)
        param_space = ParamSpace([IntParam("fast", 2, 6)])
        factory = lambda p: MomentumStrategy(fast=p["fast"], slow=15)
        result = run_optimization(
            strategy_factory=factory,
            data=df,
            param_space=param_space,
            config=OptimizationConfig(n_trials=5, timeout_seconds=1e-9, pruner_type="none"),
            baseline_evidence=_passed_evidence(),
        )
        # Should not raise; may run 0 or few trials.
        assert isinstance(result.completed, bool)
