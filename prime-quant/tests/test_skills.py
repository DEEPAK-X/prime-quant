"""Unit tests for the Agent Quant Skill Bundle (``quant``).

Covers idea-to-spec parsing, the in-memory runner's context compression
(compact JSON card, token budget, kernel-scope bindings), the validation-gate
adapter, and fail-and-refine harness telemetry.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest

import quant
from quant import refine as refine_mod
from quant.idea_to_spec import assumptions as spec_assumptions
from quant.idea_to_spec import idea_to_spec, normalize_spec
from quant import runner as runner_mod
from quant.runner import (
    MAX_CARD_TOKENS,
    CardTooLargeError,
    QuantInputError,
    card_to_json,
    run_backtest,
)
from rlm.harness import HarnessState

from tests._fxdata import synthetic_fx


def _run(coro):
    return asyncio.run(coro)


def _sample_df():
    return synthetic_fx(n_bars=400, seed=7)


# ---------------------------------------------------------------------------
# idea_to_spec
# ---------------------------------------------------------------------------


class TestIdeaToSpec:
    def test_full_prompt_fields(self) -> None:
        spec = idea_to_spec(
            "Trade EURUSD on M5 with an SMA 10/30 cross, stop loss 2 ATR, "
            "take profit 3 ATR, 1.5 lots, slippage 1 pip"
        )
        assert spec["symbol"] == "EURUSD"
        assert spec["timeframe"] == "M5"
        assert spec["asset_class"] == "Forex"
        assert spec["hypothesis"]["entry"][0]["type"] == "sma_cross"
        assert spec["hypothesis"]["entry"][0]["fast"] == 10
        assert spec["hypothesis"]["entry"][0]["slow"] == 30
        assert spec["risk_model"]["stop_loss"] == {"type": "atr", "value": 2.0}
        assert spec["risk_model"]["take_profit"] == {"type": "atr", "value": 3.0}
        assert spec["risk_model"]["lot_sizing"] == {"type": "fixed", "lots": 1.5}
        assert spec["risk_model"]["units_per_lot"] == 100_000.0
        assert spec["execution_model"]["slippage"]["value"] == 10.0  # 1 pip -> 10 points
        assert spec["execution_model"]["spread"] == "variable"

    def test_defaults_surface_assumptions(self) -> None:
        spec = idea_to_spec("mean reversion on GBPJPY")
        assert spec["symbol"] == "GBPJPY"
        assert spec["timeframe"] == "M5"  # defaulted
        assert spec["asset_class"] == "Forex"  # defaulted
        assumption_text = "\n".join(spec["assumptions"]).lower()
        assert "defaulted" in assumption_text
        assert "timeframe" in assumption_text
        # Explicitly stated fields are not recorded as defaulted assumptions.
        assert not any("gbpjpy" in line for line in spec["assumptions"])

    def test_deterministic(self) -> None:
        prompt = "EURUSD M5 momentum breakout 20, stop loss 30 pips, 2 lots"
        assert idea_to_spec(prompt) == idea_to_spec(prompt)

    def test_cfd_asset_class(self) -> None:
        spec = idea_to_spec("CFD on gold, H1 breakout")
        assert spec["asset_class"] == "CFD"
        assert spec["timeframe"] == "H1"
        assert spec["hypothesis"]["entry"][0]["type"] == "breakout"

    def test_risk_parsing_pips_and_risk_fraction(self) -> None:
        spec = idea_to_spec("EURUSD M5 sma cross, stop loss 30 pips, risk 1%")
        assert spec["risk_model"]["stop_loss"] == {"type": "pips", "value": 30.0}
        assert spec["risk_model"]["lot_sizing"] == {"type": "risk_fraction", "fraction": 0.01}

    def test_normalize_spec_validates(self) -> None:
        good = idea_to_spec("EURUSD M5 sma cross")
        assert normalize_spec(good)["symbol"] == "EURUSD"
        with pytest.raises(ValueError):
            normalize_spec({"symbol": "EURUSD"})  # missing hypothesis
        with pytest.raises(ValueError):
            normalize_spec({})

    def test_assumptions_render(self) -> None:
        spec = idea_to_spec("sma cross")  # nothing explicit -> defaults surfaced
        text = spec_assumptions(spec)
        assert text.startswith("assumptions:")
        assert "symbol" in text
        assert "timeframe" in text


# ---------------------------------------------------------------------------
# runner: context compression
# ---------------------------------------------------------------------------


class TestRunner:
    def test_run_backtest_returns_compact_card(self) -> None:
        df = _sample_df()
        ns: dict = {}
        card_text = _run(run_backtest("EURUSD M5 sma cross", data=df, namespace=ns))
        card = json.loads(card_text)
        assert card["status"] == "success"
        assert card["spec"] == {
            "asset_class": "Forex",
            "symbol": "EURUSD",
            "timeframe": "M5",
        }
        metrics = card["metrics"]
        for key in (
            "sharpe_ratio",
            "sortino_ratio",
            "calmar_ratio",
            "max_drawdown_pct",
            "profit_factor",
            "win_rate",
            "expectancy_usd",
            "trades_count",
        ):
            assert key in metrics
        gate = card["validation_gate"]
        assert gate["available"] is False  # validation engine not shipped yet
        assert gate["passed"] is None
        # Context budget: the card must stay under the 150-token cap.
        assert len(card_text) // 4 <= MAX_CARD_TOKENS
        assert len(card_text) // 4 > 0

    def test_run_backtest_binds_last_variables(self) -> None:
        df = _sample_df()
        ns: dict = {}
        _run(run_backtest("EURUSD M5 sma cross", data=df, namespace=ns))
        assert "_last_backtest_df" in ns
        assert "_last_equity_curve" in ns
        assert isinstance(ns["_last_equity_curve"], list)
        assert len(ns["_last_equity_curve"]) == len(ns["_last_backtest_df"])
        assert "_last_trades" in ns
        assert "_last_result" in ns
        assert "_last_card" in ns
        # Module-level mirrors for quant.runner._last_* access.
        assert runner_mod._last_equity_curve == ns["_last_equity_curve"]

    def test_run_backtest_uses_kernel_scope_df(self) -> None:
        ns = {"df": _sample_df()}
        card = json.loads(_run(run_backtest("EURUSD M5 sma cross", namespace=ns)))
        assert card["status"] == "success"

    def test_run_backtest_raw_prompt_and_explicit_data(self) -> None:
        df = _sample_df()
        ns: dict = {}
        card = json.loads(_run(run_backtest("GBPJPY H1 breakout 20", data=df, namespace=ns)))
        assert card["status"] == "success"
        assert card["spec"]["symbol"] == "GBPJPY"
        assert card["spec"]["timeframe"] == "H1"

    def test_run_backtest_missing_data_error_card(self) -> None:
        card = json.loads(_run(run_backtest("EURUSD M5 sma cross", namespace={})))
        assert card["status"] == "error"
        assert card["error"]["type"] == "QuantInputError"

    def test_run_backtest_invalid_spec_error_card(self) -> None:
        card = json.loads(_run(run_backtest({"symbol": "EURUSD"}, data=_sample_df(), namespace={})))
        assert card["status"] == "error"

    def test_validation_gate_adapts_engine(self, monkeypatch) -> None:
        class _FakeValidate:
            def run_validation(self, equity, trades):  # noqa: ARG002
                return {
                    "deflated_sharpe": 1.32,
                    "pbo": 0.11,
                    "oos_degradation_pct": 22.4,
                    "passed": True,
                }

        monkeypatch.setitem(sys.modules, "primequant.validate", _FakeValidate())
        df = _sample_df()
        card = json.loads(_run(run_backtest("EURUSD M5 sma cross", data=df, namespace={})))
        gate = card["validation_gate"]
        assert gate["available"] is True
        assert gate["passed"] is True
        assert gate["deflated_sharpe"] == 1.32
        assert gate["pbo"] == 0.11
        assert gate["oos_degradation_pct"] == 22.4

    def test_card_to_json_enforces_budget(self) -> None:
        huge = {"metrics": {f"key_{i}": i for i in range(2000)}}
        with pytest.raises(CardTooLargeError):
            card_to_json(huge)

    def test_card_to_json_sanitizes_non_finite(self) -> None:
        card = {"status": "success", "metrics": {"profit_factor": float("inf"), "expectancy_usd": -0.0}}
        text = card_to_json(card)
        assert '"profit_factor":null' in text

    def test_validate_reuses_last_run(self) -> None:
        df = _sample_df()
        ns: dict = {}
        _run(run_backtest("EURUSD M5 sma cross", data=df, namespace=ns))
        card = json.loads(_run(quant.validate(namespace=ns)))
        assert card["status"] == "success"
        assert card["validation_gate"]["available"] is False

    def test_validate_without_prior_run_error_card(self) -> None:
        card = json.loads(_run(quant.validate(namespace={})))
        assert card["status"] == "error"

    def test_run_entry_point(self) -> None:
        ns: dict = {}
        card = json.loads(_run(quant.run("EURUSD M5 sma cross", data=_sample_df(), namespace=ns)))
        assert card["status"] == "success"


# ---------------------------------------------------------------------------
# refine: fail-and-refine harness telemetry
# ---------------------------------------------------------------------------


class TestRefine:
    def test_refine_log_failure_persists_and_dedupes(self) -> None:
        state = HarnessState(in_memory=True)
        failure = {"kind": "validation_gate", "pattern": "PBO 0.41 exceeds the 0.25 overfit gate"}
        first = refine_mod.refine_log_failure(failure, harness=state)
        assert first["status"] == "logged"
        assert first["kind"] == "validation_gate"
        assert first["duplicate"] is False

        entry = state.get("memory", first["memory_id"])
        assert entry is not None
        assert entry.path == "quant/failures"
        assert entry.metadata["kind"] == "validation_gate"
        assert entry.version == 1

        second = refine_mod.refine_log_failure(failure, harness=state)
        assert second["duplicate"] is True
        assert second["version"] == 2
        assert len(state.list("memory")) == 1  # idempotent per pattern
        assert state.refinements  # a refinement event was recorded

    def test_refine_log_failure_rlm_harness_env(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv("RLM_HARNESS_STATE_DIR", str(tmp_path))
        record = refine_mod.refine_log_failure(
            {"kind": "ast_lint", "pattern": "signal-lag: same-bar signal * ret without .shift(1)"}
        )
        assert record["status"] == "logged"
        state_file = tmp_path / "harness_state.json"
        assert state_file.exists()
        data = json.loads(state_file.read_text(encoding="utf-8"))
        assert any(key.startswith("quant_failure") for key in data["entries"]["memory"])

    def test_failure_classification(self) -> None:
        assert refine_mod._classify_failure("future-shift: df.shift(-1)") == "ast_lint"
        assert refine_mod._classify_failure("split-leakage: scaler.fit(df)") == "ast_lint"
        assert refine_mod._classify_failure("PBO 0.41 exceeds the overfit gate") == "validation_gate"
        assert refine_mod._classify_failure("engine crashed on bad column") == "backtest_error"

    def test_refine_log_failure_without_harness_dir_raises_actionable(self) -> None:
        # With no harness store configured, the write must raise an actionable
        # message (pointing at global_=True) instead of vanishing silently.
        with pytest.raises(RuntimeError, match="Local harness state requires"):
            refine_mod.refine_log_failure("boom")


# ---------------------------------------------------------------------------
# module API surface
# ---------------------------------------------------------------------------


class TestQuantModule:
    def test_public_api_exposed(self) -> None:
        for name in (
            "idea_to_spec",
            "run_backtest",
            "validate",
            "refine_log_failure",
            "assumptions",
            "normalize_spec",
        ):
            assert callable(getattr(quant, name, None)), name
        assert quant.MAX_CARD_TOKENS == 150


