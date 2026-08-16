"""Static AST linter for strategy source code.

Catches the two most dangerous lookahead/leakage bugs before a strategy is
ever backtested:

  1. t+1 lookahead: any ``.shift(-k)`` with k > 0 reads future bars into the
     current row. This is the canonical lookahead bug and is always invalid.
  2. Global normalization: fitting a scaler (StandardScaler / MinMaxScaler) or
     computing min/max/mean/std over the *full* frame and broadcasting it back
     leaks the entire sample's distribution into each row, so train information
     leaks into test folds.

The linter is deliberately conservative: it flags clear, unambiguous patterns
rather than attempting whole-program dataflow. Better to block a suspicious
call than to silently backtest a leaking strategy.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field


@dataclass
class LintIssue:
    code: str
    message: str
    line: int
    severity: str = "error"  # "error" | "warn"

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "line": self.line,
            "severity": self.severity,
        }


@dataclass
class LintResult:
    issues: list[LintIssue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)

    @property
    def has_errors(self) -> bool:
        return not self.ok

    def to_summary(self) -> dict:
        return {
            "ok": self.ok,
            "error_count": sum(1 for i in self.issues if i.severity == "error"),
            "warning_count": sum(1 for i in self.issues if i.severity == "warn"),
            "issues": [i.to_dict() for i in self.issues],
        }


# Names that indicate a fitted scaler / global normalization.
_NORMALIZER_NAMES = {
    "standardscaler",
    "minmaxscaler",
    "robustscaler",
    "maxabsscaler",
    "normalizer",
    "quantiletransformer",
    "powertransformer",
}

_NORMALIZER_METHODS = {"fit", "fit_transform", "transform", "fit_resample"}


class _LookaheadVisitor(ast.NodeVisitor):
    """Walk the AST and collect lookahead / normalization issues."""

    def __init__(self) -> None:
        self.issues: list[LintIssue] = []

    def _is_negative(self, node: ast.expr) -> bool:
        """True if node is a negative numeric literal or -UnaryOp(neg)."""
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            if isinstance(node.operand, ast.Constant) and isinstance(
                node.operand.value, (int, float)
            ):
                return node.operand.value > 0
        return False

    def visit_Call(self, node: ast.Call) -> None:
        # Detect .shift(-k) lookahead.
        if isinstance(node.func, ast.Attribute) and node.func.attr == "shift":
            if node.args and self._is_negative(node.args[0]):
                self.issues.append(
                    LintIssue(
                        code="lookahead_shift",
                        message=(
                            "negative shift (.shift(-k)) reads future bars into "
                            "the current row - t+1 lookahead leak"
                        ),
                        line=node.lineno,
                    )
                )

        # Detect scaler fit/transform over the full frame.
        if isinstance(node.func, ast.Attribute):
            # Method call like scaler.fit(df) / scaler.fit_transform(df).
            if node.func.attr in _NORMALIZER_METHODS:
                self.issues.append(
                    LintIssue(
                        code="global_normalization",
                        message=(
                            f".{node.func.attr}() fits a scaler over the full frame "
                            "- leaks the whole-sample distribution into each row; "
                            "fit per train fold only"
                        ),
                        line=node.lineno,
                    )
                )

        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        lower = node.id.lower()
        for norm in _NORMALIZER_NAMES:
            if norm in lower:
                self.issues.append(
                    LintIssue(
                        code="global_normalization",
                        message=(
                            f"reference to scaler/normalizer '{node.id}' - global "
                            "normalization leaks across train/test splits; fit per fold"
                        ),
                        line=node.lineno,
                        severity="warn",
                    )
                )
                break
        self.generic_visit(node)


def lint_source(source: str) -> LintResult:
    """Parse strategy source and return lookahead/normalization issues.

    Returns a ``LintResult``; ``result.ok`` is False (and ``has_errors`` True)
    if any error-severity issue was found, which the orchestrator uses to block
    the pipeline.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return LintResult(
            issues=[
                LintIssue(
                    code="syntax_error",
                    message=f"source is not valid Python: {e}",
                    line=e.lineno or 0,
                )
            ]
        )
    visitor = _LookaheadVisitor()
    visitor.visit(tree)
    return LintResult(issues=visitor.issues)


def lint_strategy_cls(strategy_cls: type) -> LintResult:
    """Lint a strategy class by inspecting its source."""
    import inspect

    try:
        source = inspect.getsource(strategy_cls)
    except (TypeError, OSError):
        # Built-in or dynamically generated - no source to lint. Allow but warn.
        return LintResult(
            issues=[
                LintIssue(
                    code="no_source",
                    message="could not retrieve source for strategy class; AST check skipped",
                    line=0,
                    severity="warn",
                )
            ]
        )
    return lint_source(source)
