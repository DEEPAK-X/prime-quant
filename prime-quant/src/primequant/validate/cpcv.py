"""Combinatorial Purged & Embargoed Cross-Validation (CPCV).

Implements the Lopez de Prado methodology for backtesting without lookahead
leakage. Given N contiguous groups and a test-group count k, CPCV produces
C(N, k) splits. Each split's test set is one combination of k groups; the
train set is the complement, with two leakage controls applied:

  - Purging: training bars whose forward-looking label window overlaps a test
    evaluation window are dropped. This matters when a strategy's label at bar
    t depends on returns up to t + label_horizon (e.g. a 10-bar forward
    return). Without purging the trainer would peek into the test period.
  - Embargoing: a buffer of ``embargo_bars`` is removed from the training set
    immediately after (and before) each test block to kill residual
    auto-correlation that crosses the train/test boundary.

All splits are expressed as integer bar indices against the original ordered
frame, so the caller can slice deterministically.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Iterator


@dataclass(frozen=True)
class Fold:
    """One CPCV split: disjoint train/test bar indices, leakage-controlled."""

    train: tuple[int, ...]
    test: tuple[int, ...]
    test_groups: tuple[int, ...]

    @property
    def n_train(self) -> int:
        return len(self.train)

    @property
    def n_test(self) -> int:
        return len(self.test)


@dataclass(frozen=True)
class CPCVConfig:
    n_groups: int = 6
    n_test_groups: int = 2
    label_horizon: int = 0
    """Forward-looking label length in bars; training bars whose horizon lands
    inside a test window are purged. Set 0 when labels are point-in-time."""

    embargo_bars: int = 0
    """Buffer bars removed from training adjacent to each test block."""


def _group_boundaries(n_bars: int, n_groups: int) -> list[tuple[int, int]]:
    """Partition [0, n_bars) into n_groups contiguous, roughly-equal groups."""
    if n_groups <= 0:
        raise ValueError("n_groups must be > 0")
    if n_groups > n_bars:
        raise ValueError(f"n_groups ({n_groups}) exceeds n_bars ({n_bars})")
    base = n_bars // n_groups
    rem = n_bars % n_groups
    bounds: list[tuple[int, int]] = []
    start = 0
    for i in range(n_groups):
        size = base + (1 if i < rem else 0)
        bounds.append((start, start + size))
        start += size
    return bounds


def _test_blocks(
    test_groups: tuple[int, ...],
    bounds: list[tuple[int, int]],
) -> list[tuple[int, int]]:
    """Merge adjacent selected groups into contiguous [start, end) blocks."""
    selected = sorted(test_groups)
    blocks: list[tuple[int, int]] = []
    for g in selected:
        s, e = bounds[g]
        if blocks and blocks[-1][1] == s:
            prev_s, _ = blocks.pop()
            blocks.append((prev_s, e))
        else:
            blocks.append((s, e))
    return blocks


def _purge_and_embargo(
    full_range: range,
    test_blocks: list[tuple[int, int]],
    label_horizon: int,
    embargo_bars: int,
) -> list[int]:
    """Return training indices with purged + embargoed bars removed.

    A bar i is dropped from training if its label window [i, i+label_horizon]
    overlaps any test block, or if it falls within embargo_bars of a test
    block boundary.
    """
    keep: list[int] = []
    for i in full_range:
        # Purge: label window reaches into a test block.
        label_end = i + label_horizon
        purged = any(s <= label_end and i < e for s, e in test_blocks)
        if purged:
            continue
        # Embargo: within embargo_bars after a test block ends, or before one
        # starts (symmetric buffer to kill autocorrelation both ways).
        embargoed = any(
            (0 <= i - e < embargo_bars) or (0 <= s - i < embargo_bars)
            for s, e in test_blocks
        )
        if embargoed:
            continue
        keep.append(i)
    return keep


class CPCVSplitter:
    """Generate CPCV folds for an ordered series of ``n_bars`` observations."""

    def __init__(self, n_bars: int, config: CPCVConfig | None = None):
        if n_bars <= 0:
            raise ValueError("n_bars must be > 0")
        self.n_bars = n_bars
        self.config = config or CPCVConfig()
        self._bounds = _group_boundaries(n_bars, self.config.n_groups)

    @property
    def n_splits(self) -> int:
        n = self.config.n_groups
        k = self.config.n_test_groups
        if k <= 0 or k >= n:
            raise ValueError("n_test_groups must be in (0, n_groups)")
        # C(n, k)
        result = 1
        for i in range(k):
            result = result * (n - i) // (i + 1)
        return result

    def split(self) -> Iterator[Fold]:
        n = self.config.n_groups
        k = self.config.n_test_groups
        if k <= 0 or k >= n:
            raise ValueError("n_test_groups must be in (0, n_groups)")

        all_idx = range(self.n_bars)
        for test_groups in combinations(range(n), k):
            test_blocks = _test_blocks(test_groups, self._bounds)
            test_idx = tuple(i for s, e in test_blocks for i in range(s, e))
            train_idx = tuple(
                _purge_and_embargo(
                    all_idx,
                    test_blocks,
                    self.config.label_horizon,
                    self.config.embargo_bars,
                )
            )
            yield Fold(
                train=train_idx,
                test=test_idx,
                test_groups=test_groups,
            )


def split_summary(folds: list[Fold]) -> dict:
    """Compact JSON summary of a set of folds (no raw indices)."""
    return {
        "n_folds": len(folds),
        "avg_train_size": (
            sum(f.n_train for f in folds) / len(folds) if folds else 0
        ),
        "avg_test_size": (
            sum(f.n_test for f in folds) / len(folds) if folds else 0
        ),
        "min_train_size": min((f.n_train for f in folds), default=0),
        "min_test_size": min((f.n_test for f in folds), default=0),
    }
