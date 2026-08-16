"""Statistical anti-overfit metrics (Lopez de Prado).

Three complementary signals that a backtest is fitting noise rather than
signal:

  - Deflated Sharpe Ratio (DSR): the probability that the observed Sharpe is
    a draw from the null distribution of the *best* of N independent trials.
    Repeatedly testing strategies inflates the chance of a lucky high Sharpe;
    DSR penalizes the observed Sharpe for the number of trials, the variance
    of trial Sharpes, and non-normality (skew/kurtosis) of returns.

  - Probability of Backtest Overfitting (PBO): the probability that the
    strategy selected as optimal in-sample underperforms the median
    out-of-sample. Combinatorial purged CV produces many IS/OOS pairs; if the
    IS-best ranks badly OOS more than half the time, the strategy is overfit.

  - IS vs OOS degradation ratio: how much performance drops from in-sample to
    out-of-sample. Large degradation = overfit.

All functions take compact arrays/scalars and return floats or JSON-ready
dicts. No raw frames cross the boundary.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np


def _arr(x: Iterable[float]) -> np.ndarray:
    return np.asarray(list(x), dtype=float)


# --------------------------------------------------------------------------
# Sharpe helpers
# --------------------------------------------------------------------------

def annualized_sharpe(returns: Iterable[float], periods_per_year: int = 252) -> float:
    r = _arr(returns)
    if r.size < 2:
        return 0.0
    sd = float(r.std(ddof=1))
    if sd < 1e-12:  # guard against float-error inflation from near-constant returns
        return 0.0
    return float(r.mean() / sd * math.sqrt(periods_per_year))


def _moments(r: np.ndarray) -> tuple[float, float, float, float]:
    """Return (mean, std, skew, kurtosis_excess) of a returns array."""
    if r.size < 2:
        return 0.0, 0.0, 0.0, 0.0
    mu = float(r.mean())
    sd = float(r.std(ddof=1))
    if sd == 0:
        return mu, 0.0, 0.0, 0.0
    skew = float(((r - mu) ** 3).mean() / sd**3)
    kurt = float(((r - mu) ** 4).mean() / sd**4 - 3.0)  # excess kurtosis
    return mu, sd, skew, kurt


# --------------------------------------------------------------------------
# Deflated Sharpe Ratio
# --------------------------------------------------------------------------

@dataclass
class DSRResult:
    sharpe_observed: float
    sharpe_deflated: float
    dsr: float
    n_trials: int
    expected_max_sharpe: float

    def to_dict(self) -> dict:
        return {
            "sharpe_observed": self.sharpe_observed,
            "sharpe_deflated": self.sharpe_deflated,
            "dsr": self.dsr,
            "n_trials": self.n_trials,
            "expected_max_sharpe": self.expected_max_sharpe,
        }


def _expected_max_sharpe(
    n_trials: int,
    mean_sharpe: float,
    std_sharpe: float,
) -> float:
    """Expected maximum of N draws from N(sharpe_mean, sharpe_std).

    Uses the analytic approximation E[max of N iid normals] via the expected
    order statistic. For N>=1 this is mean + std * e_N where e_N is the
    expected max of N standard normals (approximated by the inverse CDF at
    1 - 1/N with a continuity-ish correction).
    """
    if n_trials <= 1:
        return mean_sharpe
    if std_sharpe <= 0:
        return mean_sharpe
    # Expected max of N standard normals (Royston / Blom approx).
    # e_N ≈ Phi^{-1}(1 - 1/N) for large N; add small correction.
    from math import erf, sqrt

    def _norm_ppf(p: float) -> float:
        # Inverse error function approximation (Winitzki).
        # p is a *two-sided* probability here; convert to erf domain.
        # We want x s.t. Phi(x) = p. Use the standard rational approx.
        a = -3.969683028665376e01
        b = 2.209460984245205e02
        c = -2.759285104469687e02
        d = 1.383577518672690e02
        e = -3.066479806614716e01
        f = 2.506628277459239e00
        pl = 0.02425
        ph = 1.0 - pl
        if p < pl:
            q = math.sqrt(-2.0 * math.log(p))
            return (((((c * q + d) * q + e) * q + f) * q) / ((((a * q + b) * q + c) * q + d) * q + 1))
        if p <= ph:
            q = p - 0.5
            r = q * q
            return (((((a * r + b) * r + c) * r + d) * q) / (((((e * r + f) * r) * r) * r + 1)))
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        return -(((((c * q + d) * q + e) * q + f) * q) / ((((a * q + b) * q + c) * q + d) * q + 1))

    e_n = _norm_ppf(1.0 - 1.0 / n_trials)
    # For very small N the ppf underestimates; nudge with a correction.
    if n_trials <= 5:
        # empirical correction toward known small-N expected maxima
        small_n = {1: 0.0, 2: 0.5642, 3: 0.8463, 4: 1.0294, 5: 1.1630}
        e_n = small_n.get(n_trials, e_n)
    return mean_sharpe + std_sharpe * e_n


def deflated_sharpe_ratio(
    observed_returns: Iterable[float],
    trial_sharpes: Iterable[float],
    *,
    periods_per_year: int = 252,
) -> DSRResult:
    """Compute the Deflated Sharpe Ratio.

    ``observed_returns`` are the per-bar returns of the selected strategy.
    ``trial_sharpes`` are the annualized Sharpes of all strategies tried
    (including the selected one). DSR penalizes the observed Sharpe for the
    number of trials and the dispersion of trial outcomes, and for the
    non-normality (skew, kurtosis) of the observed returns.

    Returns DSRResult: ``dsr`` in [0, 1] is the probability that the observed
    Sharpe exceeds the expected max Sharpe under the null of no skill. A low
    DSR (<0.95) means the observed edge is plausibly just selection bias.
    """
    r = _arr(observed_returns)
    if r.size < 2:
        return DSRResult(0.0, 0.0, 0.0, len(list(trial_sharpes)), 0.0)
    sharpe_obs = annualized_sharpe(r, periods_per_year)

    trials = _arr(trial_sharpes)
    n_trials = int(trials.size)
    if n_trials == 0:
        n_trials = 1
        trials = np.array([sharpe_obs])
    mean_sh = float(trials.mean())
    std_sh = float(trials.std(ddof=1)) if trials.size > 1 else 0.0

    sharpe_0 = _expected_max_sharpe(n_trials, mean_sh, std_sh)

    # Non-normality adjustment to the variance of the Sharpe estimator.
    _, sd, skew, kurt = _moments(r)
    if sd == 0:
        sharpe_deflated = 0.0
        dsr_prob = 0.0
    else:
        # Variance of Sharpe under non-normality (Lo 2002 / Bailey & Lopez de Prado).
        n = r.size
        var_sharpe = (
            (1.0 / (n - 1))
            * (1.0 - skew * sharpe_obs * math.sqrt(periods_per_year) / n
               + (kurt - 1.0) / 4.0 * (sharpe_obs * math.sqrt(periods_per_year)) ** 2 / n)
        )
        se = math.sqrt(max(var_sharpe, 1e-12))
        # Deflated Sharpe: standardize observed against the expected-max null.
        # DSR = Phi((sharpe_obs - sharpe_0) / se), clipped to [0,1].
        z = (sharpe_obs - sharpe_0) / se
        dsr_prob = float(0.5 * (1.0 + math.erf(z / math.sqrt(2.0))))
        sharpe_deflated = float(sharpe_obs - sharpe_0)

    return DSRResult(
        sharpe_observed=float(sharpe_obs),
        sharpe_deflated=sharpe_deflated,
        dsr=max(0.0, min(1.0, dsr_prob)),
        n_trials=n_trials,
        expected_max_sharpe=float(sharpe_0),
    )


# --------------------------------------------------------------------------
# Probability of Backtest Overfitting (PBO)
# --------------------------------------------------------------------------

@dataclass
class PBOResult:
    pbo: float
    n_folds: int
    logit_pbo: float
    oos_rank_below_median_rate: float

    def to_dict(self) -> dict:
        return {
            "pbo": self.pbo,
            "n_folds": self.n_folds,
            "logit_pbo": self.logit_pbo,
            "oos_rank_below_median_rate": self.oos_rank_below_median_rate,
        }


def probability_of_backtest_overfitting(
    is_sharpes: Sequence[Sequence[float]],
    oos_sharpes: Sequence[Sequence[float]],
) -> PBOResult:
    """Probability of Backtest Overfitting (Bailey, Borwein, Lopez de Prado,
    Zhu 2017).

    Inputs are aligned across strategies: for each CPCV fold we have a vector
    of in-sample Sharpes (one per strategy) and a vector of OOS Sharpes.
    Procedure per fold:
      1. Find the IS-optimal strategy.
      2. Rank its OOS Sharpe among all strategies' OOS Sharpes for that fold.
      3. Convert the rank to a logits via the relative-rank (rf = rank/(n+1)).
      4. PBO = fraction of folds where the IS-best ranks below median OOS
         (logit < 0), averaged as the mean logit transformed back via logistic.

    A PBO > 0.5 indicates the IS-selected strategy is more likely than not to
    underperform OOS - i.e. the backtest is overfit.
    """
    n_folds = len(is_sharpes)
    if n_folds == 0 or len(oos_sharpes) != n_folds:
        return PBOResult(0.0, 0, 0.0, 0.0)

    logits: list[float] = []
    below_median = 0
    for is_vec, oos_vec in zip(is_sharpes, oos_sharpes):
        is_arr = _arr(is_vec)
        oos_arr = _arr(oos_vec)
        n_strat = is_arr.size
        if n_strat < 2 or oos_arr.size != n_strat:
            continue
        best_is = int(np.argmax(is_arr))
        # OOS rank of the IS-best (1 = best).
        order = np.argsort(-oos_arr)  # descending
        rank = int(np.where(order == best_is)[0][0]) + 1
        rf = rank / (n_strat + 1.0)
        logit = math.log(rf / (1.0 - rf))
        logits.append(logit)
        if rank > n_strat / 2.0:
            below_median += 1

    if not logits:
        return PBOResult(0.0, n_folds, 0.0, 0.0)

    mean_logit = float(np.mean(logits))
    pbo = float(1.0 / (1.0 + math.exp(-mean_logit)))
    rate = below_median / len(logits)
    return PBOResult(
        pbo=pbo,
        n_folds=len(logits),
        logit_pbo=mean_logit,
        oos_rank_below_median_rate=float(rate),
    )


# --------------------------------------------------------------------------
# IS vs OOS degradation
# --------------------------------------------------------------------------

@dataclass
class DegradationResult:
    is_sharpe: float
    oos_sharpe: float
    degradation_pct: float
    ratio: float

    def to_dict(self) -> dict:
        return {
            "is_sharpe": self.is_sharpe,
            "oos_sharpe": self.oos_sharpe,
            "degradation_pct": self.degradation_pct,
            "ratio": self.ratio,
        }


def is_oos_degradation(
    is_sharpes: Iterable[float],
    oos_sharpes: Iterable[float],
) -> DegradationResult:
    """IS vs OOS performance degradation.

    ``degradation_pct`` is the fractional drop from IS to OOS Sharpe
    (positive = OOS worse, i.e. overfit). ``ratio`` = OOS/IS (<=1 = degraded).
    Negative or zero IS Sharpe is clamped to a small epsilon to avoid
    division blow-ups; in that case degradation is reported as 100%.
    """
    is_arr = _arr(is_sharpes)
    oos_arr = _arr(oos_sharpes)
    is_sh = float(is_arr.mean()) if is_arr.size else 0.0
    oos_sh = float(oos_arr.mean()) if oos_arr.size else 0.0

    if is_sh <= 0:
        # No positive IS edge to preserve; treat as fully degraded if OOS also
        # non-positive, else slight degradation.
        deg = 1.0 if oos_sh <= 0 else 0.0
        ratio = 0.0
    else:
        deg = (is_sh - oos_sh) / is_sh
        ratio = oos_sh / is_sh
    return DegradationResult(
        is_sharpe=is_sh,
        oos_sharpe=oos_sh,
        degradation_pct=float(deg),
        ratio=float(ratio),
    )


# --------------------------------------------------------------------------
# Fold consistency
# --------------------------------------------------------------------------

def fold_consistency(oos_sharpes: Iterable[float]) -> dict:
    """How consistent is OOS performance across folds?

    A robust strategy wins in most folds; one that flips sign or has wild
    dispersion across folds is unstable. Returns the fraction of folds with
    positive OOS Sharpe and the coefficient of variation.
    """
    arr = _arr(oos_sharpes)
    if arr.size == 0:
        return {"positive_fold_rate": 0.0, "cv": 0.0, "n": 0}
    pos = float((arr > 0).mean())
    mean = float(arr.mean())
    std = float(arr.std(ddof=1)) if arr.size > 1 else 0.0
    cv = float(abs(std / mean)) if abs(mean) > 1e-12 else float("inf")
    return {
        "positive_fold_rate": pos,
        "cv": cv,
        "n": int(arr.size),
    }
