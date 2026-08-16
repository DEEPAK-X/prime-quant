"""Declarative parameter space schema for optimization.

Type-safe parameter definitions that convert directly into Optuna trial
suggestions. This decouples strategy parameter declarations from the optimizer
so strategies stay unaware of Optuna.

Usage::

    space = ParamSpace([
        IntParam("fast", low=2, high=20),
        FloatParam("stop", low=0.001, high=0.02, log=True),
        CategoricalParam("mode", choices=["trend", "revert"]),
    ])
    params = space.suggest(trial)  # -> dict[str, int|float|str]
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence


@dataclass(frozen=True)
class Param:
    """Base parameter definition."""

    name: str

    def suggest(self, trial: Any) -> Any:  # pragma: no cover - abstract
        raise NotImplementedError


@dataclass(frozen=True)
class IntParam(Param):
    """Integer parameter over [low, high], optionally stepped."""

    low: int = 0
    high: int = 1
    step: int = 1

    def suggest(self, trial: Any) -> int:
        if self.step and self.step != 1:
            return trial.suggest_int(self.name, self.low, self.high, step=self.step)
        return trial.suggest_int(self.name, self.low, self.high)


@dataclass(frozen=True)
class FloatParam(Param):
    """Float parameter over [low, high], optionally stepped or log-scaled."""

    low: float = 0.0
    high: float = 1.0
    step: float | None = None
    log: bool = False

    def suggest(self, trial: Any) -> float:
        if self.step is not None:
            return trial.suggest_float(
                self.name, self.low, self.high, step=self.step
            )
        return trial.suggest_float(
            self.name, self.low, self.high, log=self.log
        )


@dataclass(frozen=True)
class CategoricalParam(Param):
    """Categorical parameter over a fixed choice set."""

    choices: Sequence[Any] = field(default_factory=list)

    def suggest(self, trial: Any) -> Any:
        return trial.suggest_categorical(self.name, list(self.choices))


@dataclass
class ParamSpace:
    """Container of parameter definitions -> Optuna trial suggestions."""

    params: list[Param] = field(default_factory=list)

    def __init__(self, params: Sequence[Param] | None = None):
        self.params = list(params) if params else []

    def suggest(self, trial: Any) -> dict[str, Any]:
        """Return a {name: value} dict by asking the trial for each param."""
        return {p.name: p.suggest(trial) for p in self.params}

    @property
    def names(self) -> list[str]:
        return [p.name for p in self.params]

    def __len__(self) -> int:
        return len(self.params)
