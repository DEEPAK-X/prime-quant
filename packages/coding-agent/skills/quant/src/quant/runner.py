"""In-memory quant runner with context compression.

Runs a spec through ``primequant.backtest.engine`` and returns **only** a
compact JSON summary card (metrics + validation gate) to the LLM context.
Raw DataFrames, equity curves, and trade lists never cross the context
boundary: they stay bound in the persistent kernel scope as
``_last_df``, ``_last_backtest_df``, ``_last_equity_curve``,
``_last_trades``, ``_last_result``, ``_last_strategy``, and ``_last_card``
for inspection by subagents.

``run_pipeline`` runs the full workflow: AST lookahead lint -> baseline
backtest -> CPCV + walk-forward validation gate (DSR / PBO) -> conditional
Optuna optimization (only when the gate passes and a ``param_space`` is
given) -> minimalist HTML tearsheet written to disk (only
``{report_path, file_size_kb}`` enters the card).

``primequant`` (and its ``polars``/``numpy``/``optuna`` dependencies) is
imported lazily so the skill loads in any venv; when the engine is missing,
callers receive an error card with an install hint instead of a traceback.
"""

from __future__ import annotations

import copy
import json
import math
import sys
from typing import Any

from .idea_to_spec import assumptions, idea_to_spec, normalize_spec
from .refine import refine_log_failure

MAX_CARD_TOKENS = 150

# Kernel-scope binding names (never dump these into the model context).
_LAST_DF = "_last_df"
_LAST_BACKTEST_DF = "_last_backtest_df"
_LAST_EQUITY = "_last_equity_curve"
_LAST_TRADES = "_last_trades"
_LAST_RESULT = "_last_result"
_LAST_CARD = "_last_card"
_LAST_STRATEGY = "_last_strategy"

_POINT_SIZE = 0.00001  # 5-digit FX quote
_PIP_PRICE = _POINT_SIZE * 10  # 1 pip = 10 points
_PIP_VALUE_PER_LOT = 10.0  # USD per pip per lot for EURUSD-like pairs
_INITIAL_CAPITAL = 10_000.0

_PERIODS_PER_YEAR = {
    "W1": 52,
    "D1": 252,
    "H4": 1512,
    "H1": 6048,
    "M30": 12096,
    "M15": 24192,
    "M5": 72576,
    "M1": 362880,
}

_METRIC_KEY_MAP = (
    ("sharpe_ratio", "sharpe"),
    ("sortino_ratio", "sortino"),
    ("calmar_ratio", "calmar"),
    ("max_drawdown_pct", "max_drawdown_pct"),
    ("profit_factor", "profit_factor"),
    ("win_rate", "win_rate"),
    ("expectancy_usd", "expectancy"),
    ("trades_count", "n_trades"),
)


class QuantUnavailableError(RuntimeError):
    """Raised when the primequant engine cannot be imported."""


class QuantInputError(ValueError):
    """Raised when the input data or spec cannot be resolved."""


class CardTooLargeError(ValueError):
    """Raised when a summary card would exceed the context token budget."""


# ---------------------------------------------------------------------------
# Context compression helpers
# ---------------------------------------------------------------------------


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _json_safe(value: Any) -> Any:
    # numpy scalars (floats, ints, bools) are not JSON-serializable directly.
    if hasattr(value, "item") and hasattr(value, "dtype"):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def card_to_json(card: dict[str, Any]) -> str:
    """Serialize a card, enforcing the compact context token budget."""
    text = json.dumps(_json_safe(card), sort_keys=True, separators=(",", ":"), allow_nan=False)
    if _estimate_tokens(text) > MAX_CARD_TOKENS:
        raise CardTooLargeError(
            f"summary card exceeds the {MAX_CARD_TOKENS}-token context budget "
            f"({_estimate_tokens(text)} tokens); drop optional fields"
        )
    return text


def _error_card(error: BaseException, hint: str = "") -> str:
    message = str(error).strip() or type(error).__name__
    if len(message) > 220:
        message = f"{message[:217]}..."
    card: dict[str, Any] = {"status": "error", "error": {"type": type(error).__name__, "message": message}}
    if hint:
        card["error"]["hint"] = hint
    return card_to_json(card)


def _blocked_card(lint_summary: dict[str, Any], reason: str) -> str:
    issues = lint_summary.get("issues") or []
    first_message = ""
    if issues and isinstance(issues[0], dict):
        first_message = str(issues[0].get("message", ""))[:120]
    card: dict[str, Any] = {
        "status": "blocked",
        "blocked_reason": reason,
        "lint": {
            "ok": lint_summary.get("ok"),
            "error_count": lint_summary.get("error_count"),
            "warning_count": lint_summary.get("warning_count"),
            "first_issue": first_message,
        },
    }
    return card_to_json(card)


def _caller_namespace() -> dict[str, Any]:
    """The kernel user namespace (or test namespace) that called this module.

    Walks past any ``quant`` module frames so bindings land in the IPython user
    namespace regardless of whether the caller invoked ``rlm.quant.run_backtest``
    directly or through the module's ``run()`` entry point.
    """
    frame = sys._getframe(2)
    while frame is not None:
        module_name = frame.f_globals.get("__name__") or ""
        if not module_name.startswith("quant"):
            return frame.f_globals
        frame = frame.f_back
    return {}


def _bind_last(namespace: dict[str, Any], **bindings: Any) -> None:
    for name, value in bindings.items():
        namespace[name] = value
        setattr(sys.modules[__name__], name, value)


# ---------------------------------------------------------------------------
# Spec -> engine adapters
# ---------------------------------------------------------------------------


def _periods_per_year(timeframe: str) -> int:
    return _PERIODS_PER_YEAR.get(str(timeframe).upper(), 252)


def _points_for(distance: dict[str, Any]) -> float:
    """Convert a spec distance (atr/pips/ticks) into engine price points."""
    value = float(distance.get("value", 0.0))
    if distance.get("type") == "pips":
        return value * 10
    if distance.get("type") == "ticks":
        return value
    return value  # atr is not expressible in fixed points; used only for risk notes


class _SpecStrategy:
    """Strategy adapter built from a validated spec hypothesis.

    Supports ``sma_cross``, ``breakout`` (donchian), and ``rsi_zone`` entry
    rules plus ``flat_on_flip`` exits. Emits lot-sized target positions
    (signed lots), applying fixed or risk-fraction sizing. All indicators use
    only past data (rolling windows; donchian extremes are shifted one bar),
    so signals carry no lookahead.
    """

    name = "quant_spec"

    def __init__(
        self,
        hypothesis: dict[str, Any],
        *,
        sizing: dict[str, Any],
        pip_value_per_lot: float = _PIP_VALUE_PER_LOT,
        point_size: float = _POINT_SIZE,
        initial_capital: float = _INITIAL_CAPITAL,
        max_lots: float = 10.0,
    ) -> None:
        entry = hypothesis.get("entry") or []
        if not entry:
            raise QuantInputError("spec.hypothesis.entry must not be empty")
        self.entry = entry
        self.sizing = sizing
        self.pip_value_per_lot = pip_value_per_lot
        self.point_size = point_size
        self.initial_capital = initial_capital
        self.max_lots = max_lots

    def prepare(self, df: Any) -> Any:
        import polars as pl

        out = df
        for rule in self.entry:
            rule_type = rule.get("type")
            if rule_type == "sma_cross":
                out = out.with_columns(
                    [
                        pl.col("close").rolling_mean(int(rule.get("fast", 10))).alias("sma_fast"),
                        pl.col("close").rolling_mean(int(rule.get("slow", 30))).alias("sma_slow"),
                    ]
                )
            elif rule_type == "breakout":
                period = int(rule.get("period", 20))
                out = out.with_columns(
                    [
                        pl.col("high").rolling_max(period).shift(1).alias("donchian_high"),
                        pl.col("low").rolling_min(period).shift(1).alias("donchian_low"),
                    ]
                )
            elif rule_type == "rsi_zone":
                period = int(rule.get("period", 14))
                out = out.with_columns([_rsi_expr(period).alias("rsi")])
            else:
                raise QuantInputError(f"unsupported entry rule type {rule_type!r}")
        out = out.with_columns([_atr_expr(14).alias("atr")])
        return out

    def _rule_conditions(self) -> tuple[list[Any], list[Any]]:
        import polars as pl

        long_conds: list[Any] = []
        short_conds: list[Any] = []
        for rule in self.entry:
            rule_type = rule.get("type")
            if rule_type == "sma_cross":
                long_conds.append(pl.col("sma_fast") > pl.col("sma_slow"))
            elif rule_type == "breakout":
                long_conds.append(pl.col("close") > pl.col("donchian_high"))
                short_conds.append(pl.col("close") < pl.col("donchian_low"))
            elif rule_type == "rsi_zone":
                long_conds.append(pl.col("rsi") < float(rule.get("oversold", 30)))
                short_conds.append(pl.col("rsi") > float(rule.get("overbought", 70)))
        return long_conds, short_conds

    def signals(self, df: Any) -> Any:
        import polars as pl

        from primequant.strategy.base import SignalResult

        prepared = self.prepare(df)
        long_conds, short_conds = self._rule_conditions()

        long = pl.any_horizontal(*long_conds) if len(long_conds) > 1 else long_conds[0]
        short = pl.any_horizontal(*short_conds) if len(short_conds) > 1 else (short_conds[0] if short_conds else pl.lit(False))
        direction = (
            pl.when(long & ~short)
            .then(1.0)
            .when(short & ~long)
            .then(-1.0)
            .otherwise(0.0)
        )

        sizing_type = self.sizing.get("type", "fixed")
        if sizing_type == "fixed":
            target = direction * float(self.sizing.get("lots", 1.0))
        elif sizing_type == "risk_fraction":
            fraction = float(self.sizing.get("fraction", 0.01))
            risk_per_lot = pl.col("atr") * self.pip_value_per_lot / (self.point_size * 10)
            lots = (fraction * self.initial_capital / risk_per_lot).clip(
                lower_bound=0.0, upper_bound=self.max_lots
            )
            target = (direction * lots).round(2)
        else:
            raise QuantInputError(f"unsupported lot sizing type {sizing_type!r}")

        out = prepared.with_columns(target.alias("target_lots"))
        return SignalResult(df=out.select("time", "target_lots"))


def _rsi_expr(period: int) -> Any:
    import polars as pl

    diff = pl.col("close").diff()
    gains = pl.when(diff > 0).then(diff).otherwise(0.0)
    losses = pl.when(diff < 0).then(-diff).otherwise(0.0)
    avg_gain = gains.rolling_mean(period)
    avg_loss = losses.rolling_mean(period)
    rs = pl.when(avg_loss > 0).then(avg_gain / avg_loss).otherwise(float("inf"))
    return 100.0 - 100.0 / (1.0 + rs)


def _atr_expr(period: int) -> Any:
    import polars as pl

    tr = pl.max_horizontal(
        pl.col("high") - pl.col("low"),
        (pl.col("high") - pl.col("close")).abs(),
        (pl.col("low") - pl.col("close")).abs(),
    )
    return tr.rolling_mean(period)


def _build_config(spec: dict[str, Any]) -> Any:
    from primequant.backtest.engine import (
        BacktestConfig,
        CommissionTier,
        InstrumentMeta,
        SlippageModel,
    )

    slippage = spec["execution_model"]["slippage"]
    slippage_points = _points_for(slippage)
    return BacktestConfig(
        initial_capital=_INITIAL_CAPITAL,
        instrument=InstrumentMeta(
            symbol=spec["symbol"],
            point_size=_POINT_SIZE,
            pip_value_per_lot=_PIP_VALUE_PER_LOT,
        ),
        commission=CommissionTier(
            usd_per_lot_per_side=float(spec["execution_model"]["commission"].get("usd_per_lot_per_side", 7.0))
        ),
        slippage=SlippageModel(slippage_points=slippage_points),
        periods_per_year=_periods_per_year(spec["timeframe"]),
    )


def _resolve_data(data: Any, namespace: dict[str, Any]) -> Any:
    import polars as pl

    if data is None:
        candidate = namespace.get("df")
        if candidate is None:
            raise QuantInputError(
                "no data provided and no `df` bound in the kernel scope; "
                "pass data= or load an OHLCV frame into `df` first"
            )
        return candidate
    if isinstance(data, str):
        if data.endswith(".parquet"):
            return pl.read_parquet(data)
        return pl.read_csv(data)
    if isinstance(data, pl.DataFrame):
        return data
    module = type(data).__module__
    if module.startswith("pandas"):
        return pl.from_pandas(data)
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return pl.DataFrame(data)
    raise QuantInputError(
        f"unsupported data type {type(data).__name__}; pass a polars DataFrame, "
        "a CSV/parquet path, or a list of row dicts"
    )


def _prepare(
    spec: dict[str, Any] | str,
    data: Any,
    namespace: dict[str, Any],
) -> tuple[dict[str, Any], Any, Any, Any, Any]:
    """Resolve spec + data + strategy + config; prints surfaced assumptions."""
    try:
        from primequant.backtest.engine import run_backtest as engine_run
    except Exception as exc:
        raise QuantUnavailableError(
            "primequant is not installed in this kernel environment; "
            "install the prime-quant package (polars + numpy) and restart the kernel"
        ) from exc

    spec_dict = spec if isinstance(spec, dict) else idea_to_spec(spec)
    spec_dict = normalize_spec(spec_dict)
    for line in assumptions(spec_dict).splitlines():
        print(line)

    df = _resolve_data(data, namespace)
    strategy = _SpecStrategy(
        spec_dict["hypothesis"],
        sizing=spec_dict["risk_model"]["lot_sizing"],
        initial_capital=_INITIAL_CAPITAL,
    )
    config = _build_config(spec_dict)
    return spec_dict, df, strategy, config, engine_run


# ---------------------------------------------------------------------------
# AST lookahead lint
# ---------------------------------------------------------------------------


def _lint_strategy() -> tuple[dict[str, Any], bool]:
    """Lint the strategy builder source via ``primequant.validate.ast_linter``.

    Returns (summary, has_errors). A failure to import or run the linter is
    treated as an error so the pipeline fails closed rather than backtesting
    an unvetted strategy.
    """
    try:
        from primequant.validate.ast_linter import lint_strategy_cls

        result = lint_strategy_cls(_SpecStrategy)
        return result.to_summary(), result.has_errors
    except Exception as exc:
        summary = {
            "ok": False,
            "error_count": 1,
            "warning_count": 0,
            "issues": [
                {
                    "code": "lint_unavailable",
                    "message": f"AST lint could not run: {type(exc).__name__}: {str(exc)[:100]}",
                    "line": 0,
                    "severity": "error",
                }
            ],
        }
        return summary, True


# ---------------------------------------------------------------------------
# Validation gate
# ---------------------------------------------------------------------------


def _unavailable_gate(reason: str) -> dict[str, Any]:
    return {
        "available": False,
        "passed": None,
        "deflated_sharpe": None,
        "pbo": None,
        "oos_degradation_pct": None,
        "reason": reason[:120],
    }


def _num(value: Any, digits: int = 3) -> float | None:
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


def _evidence_gate(evidence: Any) -> dict[str, Any]:
    dsr = getattr(evidence, "dsr", None) or {}
    pbo = getattr(evidence, "pbo", None) or {}
    degradation = getattr(evidence, "degradation", None) or {}
    oos_pct = None
    if isinstance(degradation, dict) and isinstance(degradation.get("degradation_pct"), (int, float)):
        oos_pct = _num(float(degradation["degradation_pct"]) * 100.0, 1)
    return {
        "available": True,
        "passed": bool(getattr(evidence, "passed", None)),
        "deflated_sharpe": _num(dsr.get("dsr")) if isinstance(dsr, dict) else None,
        "pbo": _num(pbo.get("pbo")) if isinstance(pbo, dict) else None,
        "oos_degradation_pct": oos_pct,
    }


def _run_validation(df: Any, strategy: Any) -> tuple[dict[str, Any], Any | None]:
    """Run CPCV + walk-forward (DSR / PBO) via primequant.validate.pipeline.

    Returns (gate_dict, evidence). The evidence object is only handed to
    ``run_pipeline`` (tearsheet / optimization); the gate dict is the compact
    context-boundary shape.
    """
    try:
        import primequant.validate.pipeline as vp
    except Exception as exc:
        return _unavailable_gate(f"primequant.validate is not installed ({type(exc).__name__})"), None

    try:
        evidence = vp.run_validation_pipeline(df, strategy, config=vp.ValidationConfig())
    except Exception as exc:  # noqa: BLE001 - a broken gate must not kill the backtest
        return _unavailable_gate(f"validation engine failed: {type(exc).__name__}: {str(exc)[:100]}"), None
    return _evidence_gate(evidence), evidence


def run_validation_gate(df: Any, strategy: Any) -> dict[str, Any]:
    """Run the anti-overfit gate and return the compact card shape."""
    gate, _ = _run_validation(df, strategy)
    return gate


# ---------------------------------------------------------------------------
# Optimization (conditional, gate-gated)
# ---------------------------------------------------------------------------


def _supported_params(spec_dict: dict[str, Any]) -> set[str]:
    """Param names the spec's entry rules can absorb during optimization."""
    supported: set[str] = set()
    for rule in spec_dict["hypothesis"]["entry"]:
        rule_type = rule.get("type")
        if rule_type == "sma_cross":
            supported.update(("fast", "slow"))
        elif rule_type in ("breakout", "rsi_zone"):
            supported.add("period")
    return supported


def _optimization_factory(spec_dict: dict[str, Any]) -> Any:
    """Build a strategy factory mapping sampled params onto the spec's entry rules."""

    def factory(params: dict[str, Any]) -> _SpecStrategy:
        hypothesis = copy.deepcopy(spec_dict["hypothesis"])
        supported: set[str] = set()
        for rule in hypothesis["entry"]:
            rule_type = rule.get("type")
            if rule_type == "sma_cross":
                supported.update(("fast", "slow"))
                if "fast" in params:
                    rule["fast"] = int(params["fast"])
                if "slow" in params:
                    rule["slow"] = int(params["slow"])
            elif rule_type in ("breakout", "rsi_zone"):
                supported.add("period")
                if "period" in params:
                    rule["period"] = int(params["period"])
        unknown = set(params) - supported
        if unknown:
            raise QuantInputError(
                f"unsupported optimization params {sorted(unknown)} for entry "
                f"rules {[r.get('type') for r in hypothesis['entry']]}"
            )
        return _SpecStrategy(
            hypothesis,
            sizing=spec_dict["risk_model"]["lot_sizing"],
            initial_capital=_INITIAL_CAPITAL,
        )

    return factory


def _param_space_from_dict(space: dict[str, Any]) -> Any:
    """Coerce an agent-friendly {name: [low, high] | choices} dict to a ParamSpace."""
    from primequant.optimize.schema import CategoricalParam, FloatParam, IntParam, ParamSpace

    params: list[Any] = []
    for name, spec in space.items():
        if not isinstance(name, str) or not name:
            raise QuantInputError(f"param_space keys must be non-empty strings, got {name!r}")
        if isinstance(spec, (list, tuple)) and len(spec) == 2:
            lo, hi = spec
            if isinstance(lo, int) and isinstance(hi, int):
                params.append(IntParam(name, low=lo, high=hi))
            elif isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
                params.append(FloatParam(name, low=float(lo), high=float(hi)))
            else:
                params.append(CategoricalParam(name, choices=[lo, hi]))
        elif isinstance(spec, (list, tuple)):
            params.append(CategoricalParam(name, choices=list(spec)))
        else:
            raise QuantInputError(
                f"param_space entry {name!r} must be a [low, high] pair or a choice list"
            )
    return ParamSpace(params)


# ---------------------------------------------------------------------------
# Public skill API
# ---------------------------------------------------------------------------


def _metrics_card(metrics: dict[str, Any]) -> dict[str, Any]:
    card: dict[str, Any] = {}
    for card_key, engine_key in _METRIC_KEY_MAP:
        value = metrics.get(engine_key, 0.0)
        if card_key == "trades_count":
            card[card_key] = int(value)
        else:
            card[card_key] = round(float(value), 2) if isinstance(value, (int, float)) else value
    return card


def _spec_summary(spec_dict: dict[str, Any]) -> dict[str, str]:
    return {
        "asset_class": spec_dict["asset_class"],
        "symbol": spec_dict["symbol"],
        "timeframe": spec_dict["timeframe"],
    }


def _log_failure_best_effort(failure: dict[str, Any]) -> None:
    try:
        refine_log_failure(failure)
    except Exception:  # noqa: BLE001 - telemetry must never break the skill
        pass


def _bind_backtest(namespace: dict[str, Any], df: Any, strategy: Any, result: Any) -> None:
    _bind_last(
        namespace,
        **{
            _LAST_DF: df,
            _LAST_STRATEGY: strategy,
            _LAST_BACKTEST_DF: df,
            _LAST_EQUITY: list(result.equity),
            _LAST_TRADES: list(result.trades),
            _LAST_RESULT: result,
        },
    )


async def run_backtest(
    spec: dict[str, Any] | str,
    data: Any = None,
    *,
    validate: bool = True,
    lint: bool = True,
    namespace: dict[str, Any] | None = None,
) -> str:
    """Run an in-memory backtest and return a compact JSON summary card.

    - ``spec``: a validated spec dict or a raw trader prompt (parsed via
      ``idea_to_spec``; assumptions are printed before execution).
    - ``data``: polars/pandas DataFrame, CSV/parquet path, or list of row
      dicts. Omitted: uses the kernel-scope ``df``.
    - ``validate``: include the anti-overfit validation gate in the card.
    - ``lint``: run the AST lookahead lint gate on the strategy builder first.
    - ``namespace``: where to bind ``_last_*`` variables (defaults to the
      caller's kernel namespace).

    Returns only the card JSON; raw frames stay bound in the namespace as
    ``_last_df`` / ``_last_backtest_df`` / ``_last_equity_curve`` /
    ``_last_trades``.
    """
    ns = namespace if namespace is not None else _caller_namespace()
    try:
        spec_dict, df, strategy, config, engine_run = _prepare(spec, data, ns)
        if lint:
            lint_summary, has_errors = _lint_strategy()
            if has_errors:
                return _blocked_card(lint_summary, "AST lint blocked strategy")

        result = engine_run(df, strategy, config=config)
        _bind_backtest(ns, df, strategy, result)

        gate = run_validation_gate(df, strategy) if validate else None
        if gate is not None and gate.get("available") and gate.get("passed") is False:
            _log_failure_best_effort(
                {
                    "kind": "validation_gate",
                    "pattern": f"gate failed for {spec_dict['symbol']} {spec_dict['timeframe']}: "
                    f"pbo={gate.get('pbo')} dsr={gate.get('deflated_sharpe')}",
                }
            )

        card: dict[str, Any] = {
            "status": "success",
            "spec": _spec_summary(spec_dict),
            "metrics": _metrics_card(result.metrics),
            "validation_gate": gate,
        }
        _bind_last(ns, **{_LAST_CARD: card})
        return card_to_json(card)
    except Exception as exc:  # noqa: BLE001 - failures return an error card
        _log_failure_best_effort(
            {
                "kind": "backtest_error",
                "pattern": f"{type(exc).__name__}: {exc}",
            }
        )
        return _error_card(exc)


async def run_pipeline(
    spec: dict[str, Any] | str,
    data: Any = None,
    *,
    namespace: dict[str, Any] | None = None,
    param_space: dict[str, Any] | Any = None,
    report_path: str | None = None,
    optimize_trials: int = 25,
    seed: int = 42,
    lint: bool = True,
) -> str:
    """Run the full quant pipeline and return a compact JSON summary card.

    Steps: AST lookahead lint -> baseline backtest (kernel-bound ``_last_*``)
    -> CPCV + walk-forward validation gate -> conditional Optuna optimization
    (only when the gate passes and ``param_space`` is provided) -> HTML
    tearsheet written to disk (only ``{report_path, file_size_kb}`` returns).

    ``param_space`` is a ``ParamSpace`` or an agent-friendly dict like
    ``{"fast": [5, 20], "slow": [20, 60]}`` (int pairs -> integer params,
    float pairs -> float params, otherwise categorical choices). The sampled
    params are mapped onto the spec's entry rules (``fast``/``slow`` for
    ``sma_cross``, ``period`` for ``breakout``/``rsi_zone``).

    The returned card never carries raw frames or HTML; the tearsheet path
    points at the on-disk report for auditability.
    """
    ns = namespace if namespace is not None else _caller_namespace()
    try:
        spec_dict, df, strategy, config, engine_run = _prepare(spec, data, ns)
        if lint:
            lint_summary, has_errors = _lint_strategy()
            if has_errors:
                return _blocked_card(lint_summary, "AST lint blocked strategy")

        result = engine_run(df, strategy, config=config)
        _bind_backtest(ns, df, strategy, result)

        gate, evidence = _run_validation(df, strategy)
        if gate.get("available") and gate.get("passed") is False:
            _log_failure_best_effort(
                {
                    "kind": "validation_gate",
                    "pattern": f"gate failed for {spec_dict['symbol']} {spec_dict['timeframe']}: "
                    f"pbo={gate.get('pbo')} dsr={gate.get('deflated_sharpe')}",
                }
            )

        # Conditional optimization: only after a passed gate AND an explicit
        # param space. The engine itself hard-blocks without passed evidence.
        optimization: dict[str, Any] = {"skipped": True}
        if gate.get("available") and gate.get("passed") is True and param_space is not None:
            from primequant.optimize.engine import OptimizationConfig, run_optimization

            # Fail fast on params the spec's entry rules cannot absorb instead
            # of burning trials that optuna would catch one by one.
            names = list(param_space.names) if hasattr(param_space, "names") else list(param_space)
            supported = _supported_params(spec_dict)
            unknown = set(names) - supported
            if unknown:
                raise QuantInputError(
                    f"unsupported optimization params {sorted(unknown)} for entry "
                    f"rules {[r.get('type') for r in spec_dict['hypothesis']['entry']]}"
                )

            space = param_space if hasattr(param_space, "suggest") else _param_space_from_dict(param_space)
            opt_result = run_optimization(
                _optimization_factory(spec_dict),
                df,
                space,
                OptimizationConfig(n_trials=int(optimize_trials), seed=int(seed), backtest=config),
                baseline_evidence=evidence,
            )
            optimization = {
                "n_trials_run": int(opt_result.n_trials_run),
                "best_params": dict(opt_result.best.params),
            }
        elif gate.get("available") is False:
            optimization["reason"] = "validation engine unavailable"

        # Tearsheet: write HTML to disk; only the path + size enter context.
        report: dict[str, Any] = {}
        try:
            from primequant.report.tearsheet import TearsheetMeta, generate_html_tearsheet

            meta = TearsheetMeta(
                symbol=spec_dict["symbol"],
                timeframe=spec_dict["timeframe"],
                total_trades=int(result.metrics.get("n_trades", 0)),
            )
            report = generate_html_tearsheet(
                result,
                validation_evidence=evidence,
                output_path=report_path,
                meta=meta,
            )
        except Exception as exc:  # noqa: BLE001 - a broken report must not kill the pipeline
            report = {"error": str(exc)[:120]}

        card: dict[str, Any] = {
            "status": "success",
            # The pass/fail verdict lives in validation_gate.passed; duplicating
            # it here would eat into the 150-token card budget.
            "spec": _spec_summary(spec_dict),
            "metrics": _metrics_card(result.metrics),
            "validation_gate": gate,
            "optimization": optimization,
            "report": report,
        }
        _bind_last(ns, **{_LAST_CARD: card})
        return card_to_json(card)
    except Exception as exc:  # noqa: BLE001 - failures return an error card
        _log_failure_best_effort(
            {
                "kind": "backtest_error",
                "pattern": f"{type(exc).__name__}: {exc}",
            }
        )
        return _error_card(exc)


async def validate(
    spec: dict[str, Any] | str | None = None,
    data: Any = None,
    *,
    namespace: dict[str, Any] | None = None,
) -> str:
    """Return the validation-gate card for a backtest.

    With no inputs, validates the most recent kernel-scope run
    (``_last_df`` / ``_last_strategy``). Otherwise runs the backtest
    first, exactly like ``run_backtest(..., validate=True)``.
    """
    ns = namespace if namespace is not None else _caller_namespace()
    try:
        if spec is None and data is None:
            df = ns.get(_LAST_DF)
            strategy = ns.get(_LAST_STRATEGY)
            if df is None or strategy is None:
                raise QuantInputError(
                    "no previous backtest in kernel scope; run run_backtest() first or pass spec/data"
                )
            gate, _ = _run_validation(df, strategy)
            prior_card = ns.get(_LAST_CARD) if isinstance(ns.get(_LAST_CARD), dict) else {}
            card: dict[str, Any] = {
                "status": "success",
                "spec": prior_card.get("spec"),
                "metrics": prior_card.get("metrics"),
                "validation_gate": gate,
            }
            return card_to_json(card)
        return await run_backtest(spec, data, validate=True, namespace=ns)
    except Exception as exc:  # noqa: BLE001 - failures return an error card
        return _error_card(exc)


__all__ = [
    "MAX_CARD_TOKENS",
    "CardTooLargeError",
    "QuantInputError",
    "QuantUnavailableError",
    "card_to_json",
    "refine_log_failure",
    "run_backtest",
    "run_pipeline",
    "run_validation_gate",
    "validate",
]
