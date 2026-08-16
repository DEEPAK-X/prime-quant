"""AST lookahead-bias and data-leakage interceptor for quant research.

Installed as an IPython input-transform guard so strategy and backtest cells
are rejected *before* execution (``error_before_exec``: the traceback is shown
and the cell body never runs) when they contain lookahead-bias or
train/test-leakage patterns:

- ``future-shift``: negative pandas shifts (``.shift(-1)``) read future bars.
- ``future-index``: indexing at ``t + n`` (n >= 1) reads a future bar.
- ``signal-lag``: combining a bar-close signal with same-bar returns without
  executing at the next bar's open (no ``.shift(1)`` lag on the signal).
- ``global-normalization``: ``(df - df.mean()) / df.std()`` over the full
  dataset leaks future moments into every bar.
- ``split-leakage``: fitting scalers / normalizing on the full dataset before
  a train/test split.

The guard is on by default in the kernel. Skip it for a single cell by putting
a ``# prime-quant: skip-lint`` comment in the cell, disable it entirely with
``rlm.lint.disable()`` (re-enable with ``rlm.lint.enable()``), or set the
``PRIME_QUANT_AST_LINT=0`` env var on the host before the kernel starts.

The module imports cleanly without IPython (the kernel forkserver preimports
``rlm`` in a template process with no shell); ``install()`` is a no-op there.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional

SKIP_MARKER = "# prime-quant: skip-lint"

# Names conventionally used for a returns series. A bare ``signal * returns``
# multiplication is the canonical same-bar execution leak.
_RETURNS_NAMES = frozenset(
    {
        "ret",
        "rets",
        "ret_",
        "returns",
        "return_",
        "pnl",
        "pnls",
        "daily_ret",
        "daily_returns",
        "daily_rets",
        "log_ret",
        "log_returns",
        "strategy_ret",
        "strategy_returns",
        "strategy_rets",
        "period_ret",
        "period_returns",
    }
)

# Methods that transform a series into returns/periodic differences.
_RETURN_METHODS = frozenset({"pct_change", "diff"})

# Methods that fit a transformer on data (the leakage vector for scalers).
_FIT_METHODS = frozenset({"fit", "fit_transform", "fit_predict", "partial_fit"})

# Names/classes that fit on data and then transform it; fitting on the full
# dataset before a split leaks validation information into training.
_SCALER_PATTERN = re.compile(
    r"scaler|standardscal|minmaxscal|robustscal|quantiletransform|powertransform|normaliz|pca",
    re.IGNORECASE,
)

# sklearn-style functional transforms that scale the full dataset in one call.
_TRANSFORM_FUNCTIONS = frozenset({"normalize", "scale", "standardize"})

# Substring that signals a name/column already carries execution lag.
_LAG_MARKER = "_lag"
_LAGGED_SUFFIXES = ("_lagged", "_shifted")

_installed = False
_enabled = True


@dataclass(frozen=True)
class Violation:
    """One rejected lookahead/leakage pattern, with a location and a fix hint."""

    rule: str
    message: str
    line: int
    col: int
    snippet: str


class LookaheadBiasError(ValueError):
    """Raised by the pre-run guard and ``assert_clean`` when a cell is blocked."""


# ---------------------------------------------------------------------------
# Cell-level filtering
# ---------------------------------------------------------------------------


def should_skip(raw_cell: str) -> bool:
    """True when a cell must not be linted (magic/help cells, opt-out marker)."""
    stripped = raw_cell.lstrip()
    if not stripped:
        return True
    if stripped[0] in ("%", "!", "?"):
        return True
    return SKIP_MARKER in raw_cell


# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------


def _const_int(node: Optional[ast.AST]) -> Optional[int]:
    """Literal integer value of a node, unwrapping unary +/-. None if not a literal."""
    if node is None:
        return None
    if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = _const_int(node.operand)
        return -value if value is not None else None
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.UAdd):
        return _const_int(node.operand)
    return None


def _shift_periods(node: ast.Call) -> Optional[int]:
    """Literal ``periods`` value of a ``.shift()`` call; defaults to 1 for a bare call."""
    func = node.func
    if not (isinstance(func, ast.Attribute) and func.attr == "shift"):
        return None
    if node.args:
        return _const_int(node.args[0])
    for keyword in node.keywords:
        if keyword.arg == "periods":
            return _const_int(keyword.value)
    return 1


def _is_forward_shift(node: ast.AST) -> bool:
    """True when the node is a ``.shift(k)`` call with k >= 1 (execution lag)."""
    if not isinstance(node, ast.Call):
        return False
    periods = _shift_periods(node)
    return periods is not None and periods >= 1


def _is_returns_expr(node: ast.AST) -> bool:
    """True when the node is a returns-like series (name or pct_change/diff call)."""
    if isinstance(node, ast.Name):
        return node.id.lower() in _RETURNS_NAMES
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in _RETURN_METHODS:
            return True
        if isinstance(func, ast.Name) and func.id.lower() in _RETURN_METHODS:
            return True
    return False


def _subscript_column(node: ast.AST) -> Optional[str]:
    """Constant column key of a ``df["col"]`` subscript, or None."""
    if not isinstance(node, ast.Subscript):
        return None
    key = node.slice
    if isinstance(key, ast.Constant) and isinstance(key.value, str):
        return key.value
    if isinstance(key, ast.Name):
        return key.id
    return None


def _future_offset(node: Optional[ast.AST]) -> Optional[int]:
    """Positive offset when a slice/index expression is ``t + n`` (n >= 1)."""
    if not isinstance(node, ast.BinOp) or not isinstance(node.op, ast.Add):
        return None
    left_constant = _const_int(node.left)
    right_constant = _const_int(node.right)
    if isinstance(node.left, ast.Name) and right_constant is not None and right_constant >= 1:
        return right_constant
    if isinstance(node.right, ast.Name) and left_constant is not None and left_constant >= 1:
        return left_constant
    return None


def _contains_rolling_expanding(node: ast.AST) -> bool:
    for sub in ast.walk(node):
        if (
            isinstance(sub, ast.Call)
            and isinstance(sub.func, ast.Attribute)
            and sub.func.attr in ("rolling", "expanding")
        ):
            return True
    return False


def _call_receiver(node: ast.AST, attr: str) -> Optional[ast.AST]:
    """Receiver of a ``<receiver>.<attr>(...)`` call, or None."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == attr:
        return node.func.value
    return None


def _contains_sub_of_base(expr: ast.AST, base_dump: str) -> bool:
    for sub in ast.walk(expr):
        if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.Sub):
            for operand in (sub.left, sub.right):
                if ast.dump(operand) == base_dump:
                    return True
    return False


def _zscore_base(node: ast.AST) -> Optional[ast.AST]:
    """Base series when ``node`` is a full-dataset z-score ``(base - base.mean()) / base.std()``.

    Returns None for windowed variants (any ``.rolling()`` / ``.expanding()`` in
    the expression) and for anything that is not the structural z-score shape.
    """
    if not isinstance(node, ast.BinOp) or not isinstance(node.op, ast.Div):
        return None
    if _contains_rolling_expanding(node):
        return None
    for sub in ast.walk(node.left):
        mean_receiver = _call_receiver(sub, "mean")
        if mean_receiver is None:
            continue
        base_dump = ast.dump(mean_receiver)
        if not _contains_sub_of_base(node.left, base_dump):
            continue
        std_receiver = _call_receiver(node.right, "std")
        if std_receiver is not None and ast.dump(std_receiver) == base_dump:
            return mean_receiver
    return None


def _is_train_test_split_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if isinstance(func, ast.Name) and func.id == "train_test_split":
        return True
    return isinstance(func, ast.Attribute) and func.attr == "train_test_split"


def _split_calls(tree: ast.AST) -> Iterable[ast.Call]:
    for node in ast.walk(tree):
        if _is_train_test_split_call(node):
            yield node  # type: ignore[misc]


def _scaler_fit_calls(tree: ast.AST) -> Iterable[ast.Call]:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr in _FIT_METHODS):
            continue
        callee = func.value
        if isinstance(callee, ast.Name) and _SCALER_PATTERN.search(callee.id):
            yield node
        elif (
            isinstance(callee, ast.Call)
            and isinstance(callee.func, ast.Name)
            and _SCALER_PATTERN.search(callee.func.id)
        ):
            yield node
        elif isinstance(callee, ast.Attribute) and _SCALER_PATTERN.search(callee.attr):
            yield node


def _fit_data_argument(call: ast.Call) -> Optional[ast.AST]:
    if call.args:
        return call.args[0]
    for keyword in call.keywords:
        if keyword.arg in ("X", "data", "df", "features", "x"):
            return keyword.value
    return None


def _assigned_processed_names(tree: ast.AST) -> dict[str, str]:
    """Names assigned in this cell from a normalization or scaling expression."""
    sources: dict[str, str] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        value = node.value
        kind: Optional[str] = None
        if _zscore_base(value) is not None:
            kind = "normalized on the full dataset"
        elif isinstance(value, ast.Call):
            func = value.func
            if isinstance(func, ast.Attribute) and func.attr in ("transform", "fit_transform"):
                kind = "scaled by a transformer"
            elif isinstance(func, ast.Name) and func.id.lower() in _TRANSFORM_FUNCTIONS:
                kind = "scaled on the full dataset"
        if kind is None:
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                sources[target.id] = kind
    return sources


def _snippet_for(source: str, node: ast.AST) -> str:
    try:
        lines = source.splitlines()
        if 1 <= node.lineno <= len(lines):
            return lines[node.lineno - 1].strip()[:160]
    except Exception:
        pass
    return "<cell>"


def _add_violation(source: str, violations: list[Violation], rule: str, message: str, node: ast.AST) -> None:
    violations.append(
        Violation(
            rule=rule,
            message=message,
            line=node.lineno,
            col=node.col_offset,
            snippet=_snippet_for(source, node),
        )
    )


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def _check_future_shift(tree: ast.AST, source: str, violations: list[Violation]) -> None:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        periods = _shift_periods(node)
        if periods is None or periods >= 0:
            continue
        _add_violation(
            source,
            violations,
            "future-shift",
            f"Negative shift .shift({periods}) looks ahead into future bars; shift forward "
            "by a positive number of bars (e.g. .shift(1)) to lag, never lead.",
            node,
        )


def _slice_bounds(slice_node: ast.Slice) -> tuple[Optional[ast.AST], Optional[ast.AST]]:
    # ast.Slice field names changed between Python 3.10 (lower/upper) and 3.11+ (start/stop).
    start = getattr(slice_node, "start", None)
    if start is None:
        start = getattr(slice_node, "lower", None)
    stop = getattr(slice_node, "stop", None)
    if stop is None:
        stop = getattr(slice_node, "upper", None)
    return start, stop


def _check_future_index(tree: ast.AST, source: str, violations: list[Violation]) -> None:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Subscript):
            continue
        slice_node = node.slice
        if isinstance(slice_node, ast.Slice):
            parts = _slice_bounds(slice_node)
        else:
            parts = (slice_node,)
        for part in parts:
            offset = _future_offset(part)
            if offset is None:
                continue
            _add_violation(
                source,
                violations,
                "future-index",
                f"Indexing at t + {offset} reads a future bar (lookahead bias). Use t + {offset - 1}, "
                "t, or a positive .shift() to access only past/current data.",
                node,
            )


def _check_signal_lag(tree: ast.AST, source: str, violations: list[Violation]) -> None:
    shifted_names: set[str] = set()
    shifted_columns: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and _is_forward_shift(node.value):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    shifted_names.add(target.id)
                column = _subscript_column(target)
                if column is not None:
                    shifted_columns.add(column)

    def _carries_lag(signal: ast.AST) -> bool:
        if _is_forward_shift(signal):
            return True
        if isinstance(signal, ast.Name):
            lowered = signal.id.lower()
            return lowered in shifted_names or _LAG_MARKER in lowered or lowered.endswith(_LAGGED_SUFFIXES)
        column = _subscript_column(signal)
        if column is not None:
            lowered = column.lower()
            return lowered in shifted_columns or _LAG_MARKER in lowered or lowered.endswith(_LAGGED_SUFFIXES)
        if isinstance(signal, ast.Attribute):
            lowered = signal.attr.lower()
            return lowered in shifted_columns or _LAG_MARKER in lowered or lowered.endswith(_LAGGED_SUFFIXES)
        return False

    def _flag_signal_lag(node: ast.AST, signal: ast.AST, returns: ast.AST) -> None:
        if _carries_lag(signal) or _carries_lag(returns):
            return
        _add_violation(
            source,
            violations,
            "signal-lag",
            "Signal evaluated at bar close is combined with same-bar returns without execution lag. "
            "Execute at the next bar's open by lagging the signal one bar (e.g. signal.shift(1) * ret).",
            node,
        )

    for node in ast.walk(tree):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
            left, right = node.left, node.right
            if _is_returns_expr(left) and not _is_returns_expr(right):
                _flag_signal_lag(node, right, left)
            elif _is_returns_expr(right) and not _is_returns_expr(left):
                _flag_signal_lag(node, left, right)
        elif isinstance(node, ast.AugAssign) and isinstance(node.op, ast.Mult):
            if _is_returns_expr(node.target) and not _is_returns_expr(node.value):
                _flag_signal_lag(node, node.value, node.target)
            elif _is_returns_expr(node.value) and not _is_returns_expr(node.target):
                _flag_signal_lag(node, node.target, node.value)


def _check_global_normalization(tree: ast.AST, source: str, violations: list[Violation]) -> None:
    for node in ast.walk(tree):
        base = _zscore_base(node)
        if base is None:
            continue
        _add_violation(
            source,
            violations,
            "global-normalization",
            "Full-dataset normalization (df - df.mean()) / df.std() leaks future moments into every "
            "bar. Use rolling/expanding windows instead, e.g. (df - df.rolling(252).mean()) / "
            "df.rolling(252).std().",
            node,
        )


def _check_split_leakage(tree: ast.AST, source: str, violations: list[Violation]) -> None:
    split_calls = list(_split_calls(tree))
    if not split_calls:
        return

    # Fitting any scaler/transformer on data that is not train-only, in the same
    # cell as a split, leaks validation information into the fit.
    for call in _scaler_fit_calls(tree):
        data = _fit_data_argument(call)
        if not isinstance(data, ast.Name) or "train" in data.id.lower():
            continue
        _add_violation(
            source,
            violations,
            "split-leakage",
            f"Transformer fitted on the full dataset ({data.id}) before train/test split. Fit on the "
            "training split only: scaler.fit(X_train), then transform each split separately.",
            call,
        )

    # Normalizing/scaling the data before the split leaks full-dataset moments
    # into both splits. Only flagged when the leak is visible in this cell.
    processed = _assigned_processed_names(tree)
    for split_call in split_calls:
        for arg in split_call.args:
            if isinstance(arg, ast.Name) and arg.id in processed:
                _add_violation(
                    source,
                    violations,
                    "split-leakage",
                    f"Data {arg.id} was {processed[arg.id]} before the train/test split. Fit and "
                    "transform the training split first, then apply the fitted transform to the test split.",
                    split_call,
                )
            elif _zscore_base(arg) is not None:
                _add_violation(
                    source,
                    violations,
                    "split-leakage",
                    "train_test_split is called on data that was normalized on the full dataset. "
                    "Normalize inside each split, or fit the scaler on X_train only.",
                    split_call,
                )
            elif (
                isinstance(arg, ast.Call)
                and isinstance(arg.func, ast.Name)
                and arg.func.id.lower() in _TRANSFORM_FUNCTIONS
            ):
                _add_violation(
                    source,
                    violations,
                    "split-leakage",
                    "train_test_split is called on data scaled across the full dataset. Scale the "
                    "training split first and apply the same parameters to the test split.",
                    split_call,
                )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def lint(source: str) -> list[Violation]:
    """Lint a Python cell/script for lookahead bias and leakage. Empty for clean code."""
    if not isinstance(source, str):
        raise TypeError(f"source must be str, got {type(source).__name__}")
    if should_skip(source):
        return []
    try:
        tree = ast.parse(source)
    except SyntaxError:
        # The kernel reports syntax errors natively; the guard stays silent.
        return []

    violations: list[Violation] = []
    _check_future_shift(tree, source, violations)
    _check_future_index(tree, source, violations)
    _check_signal_lag(tree, source, violations)
    _check_global_normalization(tree, source, violations)
    _check_split_leakage(tree, source, violations)
    return violations


def check(source: str) -> list[Violation]:
    """Alias of :func:`lint` for agent-facing use (``rlm.lint.check(...)``)."""
    return lint(source)


def lint_file(path: str) -> list[Violation]:
    """Lint a strategy/backtest file on disk."""
    with open(path, "r", encoding="utf-8") as handle:
        return lint(handle.read())


def assert_clean(source: str) -> None:
    """Raise :class:`LookaheadBiasError` when the source contains any violation."""
    violations = lint(source)
    if violations:
        raise LookaheadBiasError(format_violations(violations))


def format_violations(violations: Iterable[Violation]) -> str:
    lines = ["prime-quant lookahead-bias guard blocked this cell before execution:", ""]
    for violation in violations:
        lines.append(f"- [{violation.rule}] line {violation.line}: {violation.message}")
        lines.append(f"    {violation.snippet}")
    lines.append("")
    lines.append("Fix the flagged patterns, or skip the guard for this cell by adding a line with:")
    lines.append(f"    {SKIP_MARKER}")
    return "\n".join(lines)


def install(shell: Any) -> bool:
    """Register the cell guard on an IPython shell. Idempotent.

    The guard is an input line-transform that raises :class:`LookaheadBiasError`
    when the cell contains violations. IPython's ``run_cell`` turns a raising
    input transform into ``error_before_exec``: the traceback is shown and the
    cell body never runs. The transform is flagged ``has_side_effects`` so
    ``check_complete()`` (incremental multi-line input detection) skips it and
    never lints half-typed cells.
    """
    global _installed
    if _installed:
        return True
    manager = getattr(shell, "input_transformer_manager", None)
    if manager is None or not hasattr(manager, "line_transforms"):
        return False

    def _guard(lines: list[str]) -> list[str]:
        if not _enabled:
            return lines
        source = "".join(lines)
        if should_skip(source):
            return lines
        violations = lint(source)
        if violations:
            raise LookaheadBiasError(format_violations(violations))
        return lines

    _guard.has_side_effects = True  # type: ignore[attr-defined]
    manager.line_transforms.append(_guard)
    _installed = True
    return True


def set_enabled(value: bool) -> None:
    global _enabled
    _enabled = bool(value)


def enable() -> None:
    set_enabled(True)


def disable() -> None:
    set_enabled(False)


def enabled() -> bool:
    return _enabled
