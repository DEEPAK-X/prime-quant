"""Tests for the validation engine: CPCV, overfit metrics, walk-forward, gate."""

from __future__ import annotations

import math

import polars as pl
import pytest

from primequant.backtest.engine import BacktestConfig
from primequant.strategy.base import FixedLotSizer, MomentumStrategy, Strategy
from primequant.validate import (
    CPCVConfig,
    CPCVSplitter,
    ValidationConfig,
    ValidationGateError,
    assert_passes,
    deflated_sharpe_ratio,
    fold_consistency,
    is_oos_degradation,
    probability_of_backtest_overfitting,
    run_validation_pipeline,
    run_walk_forward,
    WalkForwardConfig,
)
from primequant.validate.cpcv import Fold
from tests._fxdata import synthetic_fx


# ---------------------------------------------------------------------------
# CPCV
# ---------------------------------------------------------------------------

class TestCPCV:
    def test_n_splits_is_combination(self):
        s = CPCVSplitter(120, CPCVConfig(n_groups=6, n_test_groups=2))
        # C(6,2) = 15
        assert s.n_splits == 15
        assert len(list(s.split())) == 15

    def test_train_test_disjoint(self):
        s = CPCVSplitter(100, CPCVConfig(n_groups=5, n_test_groups=1))
        for fold in s.split():
            assert not (set(fold.train) & set(fold.test))

    def test_test_groups_cover_all_data(self):
        # Every bar must appear in exactly C(n-1, k-1) test sets across folds.
        s = CPCVSplitter(60, CPCVConfig(n_groups=6, n_test_groups=2))
        counts = [0] * 60
        for fold in s.split():
            for i in fold.test:
                counts[i] += 1
        # Each bar in C(5,1)=5 test sets
        assert all(c == 5 for c in counts)

    def test_purge_removes_label_overlap(self):
        # 6 groups of 20 = 120 bars. Test groups {2,3} -> block [40,80).
        # label_horizon=3: bar 37 has label window [37,40] overlapping test.
        s = CPCVSplitter(120, CPCVConfig(n_groups=6, n_test_groups=2, label_horizon=3))
        for fold in s.split():
            if fold.test_groups == (2, 3):
                train = set(fold.train)
                assert 37 not in train  # purged: label reaches into test
                assert 36 in train  # label window [36,39] does not reach 40
                # no train bar whose label reaches into test
                for i in fold.train:
                    assert i + 3 < 40 or i >= 80, f"bar {i} label leaks into test"
                return
        pytest.fail("fold (2,3) not found")

    def test_embargo_buffers_test_boundaries(self):
        s = CPCVSplitter(120, CPCVConfig(n_groups=6, n_test_groups=2, embargo_bars=3))
        for fold in s.split():
            if fold.test_groups == (2, 3):
                # test block [40,80). Embargo removes [37,39] before and
                # [80,82] after.
                train = set(fold.train)
                assert 39 not in train  # embargo before
                assert 80 not in train  # embargo after
                assert 36 in train
                assert 83 in train
                return
        pytest.fail("fold (2,3) not found")

    def test_purge_and_embargo_combined(self):
        s = CPCVSplitter(
            120,
            CPCVConfig(n_groups=6, n_test_groups=2, label_horizon=3, embargo_bars=2),
        )
        for fold in s.split():
            # Disjoint always
            assert not (set(fold.train) & set(fold.test))
            # No train bar leaks into test via label horizon
            for i in fold.train:
                assert i + 3 not in set(fold.test) or i in fold.test

    def test_no_purge_no_embargo_is_plain_combinatorial(self):
        s = CPCVSplitter(60, CPCVConfig(n_groups=6, n_test_groups=2, label_horizon=0, embargo_bars=0))
        for fold in s.split():
            # train = all bars not in test
            assert set(fold.train) == set(range(60)) - set(fold.test)

    def test_invalid_n_test_groups(self):
        s = CPCVSplitter(60, CPCVConfig(n_groups=6, n_test_groups=0))
        with pytest.raises(ValueError):
            list(s.split())
        s2 = CPCVSplitter(60, CPCVConfig(n_groups=6, n_test_groups=6))
        with pytest.raises(ValueError):
            list(s2.split())

    def test_split_summary_shape(self):
        from primequant.validate.cpcv import split_summary

        s = CPCVSplitter(60, CPCVConfig(n_groups=6, n_test_groups=2))
        folds = list(s.split())
        summ = split_summary(folds)
        assert summ["n_folds"] == 15
        assert summ["avg_train_size"] > 0
        assert summ["avg_test_size"] > 0


# ---------------------------------------------------------------------------
# Deflated Sharpe Ratio
# ---------------------------------------------------------------------------

class TestDSR:
    def test_dsr_single_trial_high_signal(self):
        # Strong, consistent positive returns with small noise -> high DSR.
        import random as _r

        rng = _r.Random(2)
        r = [0.001 + rng.gauss(0, 0.00005) for _ in range(300)]
        dsr = deflated_sharpe_ratio(r, [3.0], periods_per_year=252)
        assert dsr.dsr > 0.5
        assert dsr.n_trials == 1

    def test_dsr_penalizes_more_trials(self):
        # Same observed returns, but many trials -> lower DSR.
        # Use noisy (non-constant) returns so Sharpe is finite and sensitive
        # to the number of trials via the deflation term.
        import random as _r

        rng = _r.Random(1)
        r = [0.0008 + rng.gauss(0, 0.0003) for _ in range(300)]
        few = deflated_sharpe_ratio(r, [1.0, 1.1, 0.9], periods_per_year=252)
        many = deflated_sharpe_ratio(
            r,
            [1.0, 1.1, 0.9, 1.2, 0.8, 1.05, 0.95, 1.15, 0.85, 1.1, 0.9, 1.0] * 5,
            periods_per_year=252,
        )
        assert many.dsr <= few.dsr
        assert many.n_trials > few.n_trials

    def test_dsr_zero_for_flat_returns(self):
        dsr = deflated_sharpe_ratio([0.0] * 100, [0.0])
        assert dsr.dsr == 0.0
        assert dsr.sharpe_observed == 0.0

    def test_dsr_short_returns(self):
        dsr = deflated_sharpe_ratio([0.01], [1.0])
        assert dsr.dsr == 0.0

    def test_dsr_to_dict_shape(self):
        dsr = deflated_sharpe_ratio([0.001] * 100, [2.0, 1.5])
        d = dsr.to_dict()
        for key in ("sharpe_observed", "sharpe_deflated", "dsr", "n_trials", "expected_max_sharpe"):
            assert key in d


# ---------------------------------------------------------------------------
# PBO
# ---------------------------------------------------------------------------

class TestPBO:
    def test_pbo_low_when_oos_tracks_is(self):
        # IS-best also best OOS -> PBO low (good).
        is_sharpes = [[1.5, 0.5, 0.2], [1.4, 0.6, 0.1], [1.6, 0.4, 0.3]]
        oos_sharpes = [[1.3, 0.4, 0.1], [1.2, 0.5, 0.0], [1.4, 0.3, 0.2]]
        pbo = probability_of_backtest_overfitting(is_sharpes, oos_sharpes)
        assert pbo.pbo < 0.5
        assert pbo.n_folds == 3

    def test_pbo_high_when_is_best_fails_oos(self):
        # IS-best consistently worst OOS -> PBO high (overfit).
        is_sharpes = [[2.0, 0.1], [2.1, 0.0], [1.9, 0.2]]
        oos_sharpes = [[-0.5, 0.8], [-0.6, 0.7], [-0.4, 0.9]]
        pbo = probability_of_backtest_overfitting(is_sharpes, oos_sharpes)
        assert pbo.pbo > 0.5
        assert pbo.oos_rank_below_median_rate > 0.5

    def test_pbo_empty(self):
        pbo = probability_of_backtest_overfitting([], [])
        assert pbo.pbo == 0.0
        assert pbo.n_folds == 0

    def test_pbo_to_dict_shape(self):
        pbo = probability_of_backtest_overfitting([[1.0, 0.5]], [[0.9, 0.6]])
        d = pbo.to_dict()
        for key in ("pbo", "n_folds", "logit_pbo", "oos_rank_below_median_rate"):
            assert key in d


# ---------------------------------------------------------------------------
# IS/OOS degradation
# ---------------------------------------------------------------------------

class TestDegradation:
    def test_no_degradation(self):
        deg = is_oos_degradation([1.0, 1.1], [1.0, 1.1])
        assert math.isclose(deg.degradation_pct, 0.0, abs_tol=1e-9)
        assert math.isclose(deg.ratio, 1.0, abs_tol=1e-9)

    def test_full_degradation(self):
        deg = is_oos_degradation([1.0, 1.0], [-1.0, -1.0])
        assert deg.degradation_pct > 1.0  # more than 100% drop

    def test_negative_is_clamped(self):
        deg = is_oos_degradation([-0.5], [-0.5])
        assert deg.degradation_pct == 1.0

    def test_degradation_to_dict(self):
        deg = is_oos_degradation([2.0], [1.0])
        assert deg.to_dict()["degradation_pct"] == 0.5


# ---------------------------------------------------------------------------
# Walk-forward
# ---------------------------------------------------------------------------

class TestWalkForward:
    def test_rolling_window_produces_folds(self):
        df = synthetic_fx(n_bars=400)
        result = run_walk_forward(
            df,
            lambda train: MomentumStrategy(fast=5, slow=20),
            config=WalkForwardConfig(train_bars=200, test_bars=50),
        )
        assert len(result.folds) >= 2
        assert len(result.oos_sharpes) == len(result.folds)

    def test_expanding_window(self):
        df = synthetic_fx(n_bars=400)
        result = run_walk_forward(
            df,
            lambda train: MomentumStrategy(fast=5, slow=20),
            config=WalkForwardConfig(train_bars=150, test_bars=50, expanding=True),
        )
        assert len(result.folds) >= 2
        # Expanding: train_start always 0
        for fold in result.folds:
            assert fold.train_start == 0

    def test_no_overlap_between_train_and_test(self):
        df = synthetic_fx(n_bars=300)
        result = run_walk_forward(
            df,
            lambda train: MomentumStrategy(fast=5, slow=20),
            config=WalkForwardConfig(train_bars=150, test_bars=50, embargo_bars=5),
        )
        for fold in result.folds:
            assert fold.train_end <= fold.test_start  # embargo gap
            assert fold.test_end > fold.test_start

    def test_too_few_bars_returns_empty(self):
        df = synthetic_fx(n_bars=50)
        result = run_walk_forward(
            df,
            lambda train: MomentumStrategy(fast=5, slow=20),
            config=WalkForwardConfig(train_bars=200, test_bars=50),
        )
        assert len(result.folds) == 0

    def test_summary_shape(self):
        df = synthetic_fx(n_bars=400)
        result = run_walk_forward(
            df,
            lambda train: MomentumStrategy(fast=5, slow=20),
            config=WalkForwardConfig(train_bars=200, test_bars=50),
        )
        s = result.to_summary()
        assert s["n_folds"] >= 2
        assert "oos_sharpe_mean" in s
        assert "positive_fold_rate" in s


# ---------------------------------------------------------------------------
# Fold consistency
# ---------------------------------------------------------------------------

class TestFoldConsistency:
    def test_all_positive(self):
        c = fold_consistency([1.0, 1.5, 2.0])
        assert c["positive_fold_rate"] == 1.0
        assert c["n"] == 3

    def test_mixed(self):
        c = fold_consistency([1.0, -0.5, 2.0, -1.0])
        assert c["positive_fold_rate"] == 0.5

    def test_empty(self):
        c = fold_consistency([])
        assert c["positive_fold_rate"] == 0.0
        assert c["n"] == 0


# ---------------------------------------------------------------------------
# Validation pipeline gate
# ---------------------------------------------------------------------------

class TestValidationPipeline:
    def test_returns_evidence_with_passed_bool(self):
        df = synthetic_fx(n_bars=400, drift=0.00005, vol=0.0001)
        evidence = run_validation_pipeline(
            df,
            MomentumStrategy(fast=5, slow=20),
            config=ValidationConfig(
                cpcv=CPCVConfig(n_groups=6, n_test_groups=2, embargo_bars=3),
                walk_forward=WalkForwardConfig(train_bars=150, test_bars=50),
                min_cpcv_folds=6,
            ),
        )
        assert isinstance(evidence.passed, bool)
        assert isinstance(evidence.failure_reasons, list)

    def test_evidence_summary_shape(self):
        df = synthetic_fx(n_bars=300)
        evidence = run_validation_pipeline(
            df,
            MomentumStrategy(fast=5, slow=20),
            config=ValidationConfig(
                cpcv=CPCVConfig(n_groups=6, n_test_groups=2),
                walk_forward=WalkForwardConfig(train_bars=150, test_bars=50),
            ),
        )
        s = evidence.to_summary()
        for key in (
            "passed",
            "failure_reasons",
            "oos_sharpe_mean",
            "cpcv",
            "walk_forward",
            "dsr",
            "pbo",
            "degradation",
            "fold_consistency",
        ):
            assert key in s

    def test_overfit_strategy_fails_gate(self):
        """A strategy that overfits noise should fail the gate.

        We use a strategy that, when fit on a training segment, memorizes the
        sign of each training bar's return and replays that *same* sign
        pattern on the test segment. Because train and test returns are
        independent, the memorized pattern is uncorrelated with OOS returns,
        so it looks great in-sample (perfect fit to train noise) but fails
        out-of-sample. This is the canonical overfit that CPCV/PBO is designed
        to catch.
        """
        df = synthetic_fx(n_bars=300, vol=0.001, drift=0.0, seed=7)

        from primequant.strategy.base import SignalResult

        class MemorizeByPosition(Strategy):
            """Memorize train return signs by position; replay on any frame.

            Fit on train: store the sign of train close-to-close returns.
            Signals on any frame: replay the memorized sign at the matching
            position (cycling if the frame is longer). Perfect IS fit, pure
            noise OOS.
            """

            name = "memorize_noise"

            def __init__(self) -> None:
                self._pattern: list[float] = []

            def fit(self, train_df: pl.DataFrame) -> "MemorizeByPosition":
                closes = train_df["close"].to_list()
                pattern = [0.0]
                for i in range(1, len(closes)):
                    pattern.append(1.0 if closes[i] > closes[i - 1] else 0.0)
                self._pattern = pattern
                return self

            def signals(self, df: pl.DataFrame) -> SignalResult:
                n = df.height
                if not self._pattern:
                    pos = [0.0] * n
                else:
                    pos = [self._pattern[i % len(self._pattern)] for i in range(n)]
                out = df.with_columns(pl.Series("target_lots", pos))
                return SignalResult(df=out.select("time", "target_lots"))

        mem = MemorizeByPosition()

        def fit_fn(train_df: pl.DataFrame) -> Strategy:
            m = MemorizeByPosition()
            return m.fit(train_df)

        evidence = run_validation_pipeline(
            df,
            mem,
            config=ValidationConfig(
                cpcv=CPCVConfig(n_groups=6, n_test_groups=2, embargo_bars=2),
                walk_forward=WalkForwardConfig(train_bars=120, test_bars=40),
                min_cpcv_folds=6,
                min_dsr=0.0,  # relax so overfit-specific gates can trigger
                max_pbo=1.0,
            ),
            fit_fn=fit_fn,
        )
        # Overfit to noise: OOS should be poor, so the gate must fail.
        assert evidence.passed is False
        assert len(evidence.failure_reasons) >= 1
        # At least one overfit-specific signal should fire: degradation, PBO,
        # low positive-fold-rate, or low OOS Sharpe.
        joined = " ".join(evidence.failure_reasons).lower()
        assert any(
            kw in joined
            for kw in ("degradation", "pbo", "fold rate", "oos sharpe", "dsr")
        )

    def test_assert_passes_raises_on_failure(self):
        df = synthetic_fx(n_bars=300, vol=0.001, drift=0.0, seed=7)
        from primequant.strategy.base import SignalResult

        class Flat(Strategy):
            name = "flat"

            def signals(self, df: pl.DataFrame) -> SignalResult:
                out = df.select("time").with_columns(pl.lit(0.0).alias("target_lots"))
                return SignalResult(df=out)

        evidence = run_validation_pipeline(
            df,
            Flat(),
            config=ValidationConfig(
                cpcv=CPCVConfig(n_groups=6, n_test_groups=2),
                walk_forward=WalkForwardConfig(train_bars=120, test_bars=40),
                min_oos_sharpe=0.5,
            ),
        )
        assert evidence.passed is False
        with pytest.raises(ValidationGateError):
            assert_passes(evidence)

    def test_pipeline_blocks_optimization_when_failed(self):
        """The gate's whole purpose: failed validation blocks optimization."""
        df = synthetic_fx(n_bars=300, vol=0.001, drift=0.0, seed=3)

        from primequant.strategy.base import SignalResult

        class RandomNoise(Strategy):
            name = "random_noise"

            def signals(self, df: pl.DataFrame) -> SignalResult:
                # Pseudo-random positions that differ in vs out of sample.
                import random as _r

                _rng = _r.Random(123)
                pos = [_rng.choice([0.0, 1.0, -1.0]) for _ in range(df.height)]
                out = df.with_columns(pl.Series("target_lots", pos))
                return SignalResult(df=out.select("time", "target_lots"))

        evidence = run_validation_pipeline(
            df,
            RandomNoise(),
            config=ValidationConfig(
                cpcv=CPCVConfig(n_groups=6, n_test_groups=2, embargo_bars=2),
                walk_forward=WalkForwardConfig(train_bars=120, test_bars=40),
            ),
        )
        assert evidence.passed is False
        # The failure reasons must be non-empty and explicit.
        assert all(isinstance(r, str) and r for r in evidence.failure_reasons)
