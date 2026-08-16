"""Idea-to-spec: deterministic trader-prompt -> StrategySpec translation.

The parser is intentionally mechanical: it extracts the fields a strategy spec
needs from free-form trader language and fills every missing field with a
documented default. The same prompt always yields the same spec, and every
defaulted decision is surfaced in ``assumptions`` so the caller can see what
was inferred before any backtest code runs.
"""

from __future__ import annotations

import re
from typing import Any

ASSET_CLASS_FOREX = "Forex"
ASSET_CLASS_CFD = "CFD"

# Standard ISO 4217 codes used for FX pair detection.
_CURRENCY_CODES = frozenset(
    {
        "USD",
        "EUR",
        "JPY",
        "GBP",
        "CHF",
        "CAD",
        "AUD",
        "NZD",
        "SEK",
        "NOK",
        "DKK",
        "SGD",
        "HKD",
        "MXN",
        "ZAR",
        "TRY",
        "PLN",
        "CNH",
        "CNY",
    }
)

_TIMEFRAME_PATTERN = re.compile(r"\b(M1|M5|M15|M30|H1|H4|D1|W1)\b", re.IGNORECASE)

_PAIR_TOKEN_PATTERN = re.compile(r"\b[A-Za-z]{3}/?[A-Za-z]{3}\b")

# Entry/exit rule detection, checked in priority order so the mapping stays
# deterministic when a prompt mentions several indicators.
_RULE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("sma_cross", re.compile(r"\b(sma|simple moving average|moving average|ma|crossover|ema)\b", re.IGNORECASE)),
    ("breakout", re.compile(r"\b(breakout|donchian|highest high|lowest low|channel break)\b", re.IGNORECASE)),
    ("rsi_zone", re.compile(r"\brsi\b", re.IGNORECASE)),
)

_DEFAULT_SYMBOL = "EURUSD"
_DEFAULT_TIMEFRAME = "M5"
_DEFAULT_ASSET_CLASS = ASSET_CLASS_FOREX
_DEFAULT_STOP_LOSS = {"type": "atr", "value": 2.0}
_DEFAULT_TAKE_PROFIT = {"type": "atr", "value": 3.0}
_DEFAULT_LOT_SIZING = {"type": "fixed", "lots": 1.0}
_DEFAULT_SLIPPAGE = {"type": "points", "value": 0.5}
_DEFAULT_COMMISSION = {"usd_per_lot_per_side": 7.0}
UNITS_PER_LOT = 100_000.0

_TICKS_PER_PIP = 10  # 5-digit FX quotes: 1 pip = 10 points.


def _dedupe(entries: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for entry in entries:
        if entry not in seen:
            seen.add(entry)
            result.append(entry)
    return result


def parse_symbol(text: str) -> tuple[str, bool]:
    """Return (symbol, was_explicit)."""
    for token in _PAIR_TOKEN_PATTERN.findall(text):
        normalized = token.replace("/", "").upper()
        if len(normalized) == 6 and normalized[:3] in _CURRENCY_CODES and normalized[3:] in _CURRENCY_CODES:
            return normalized, True
    return _DEFAULT_SYMBOL, False


def parse_timeframe(text: str) -> tuple[str, bool]:
    match = _TIMEFRAME_PATTERN.search(text)
    if match:
        return match.group(1).upper(), True
    return _DEFAULT_TIMEFRAME, False


def parse_asset_class(text: str) -> tuple[str, bool]:
    lowered = text.lower()
    if "cfd" in lowered:
        return ASSET_CLASS_CFD, True
    if re.search(r"\b(forex|fx)\b", lowered):
        return ASSET_CLASS_FOREX, True
    return _DEFAULT_ASSET_CLASS, False


def _parse_distance(text: str, label: str) -> tuple[dict[str, Any], bool] | None:
    """Parse 'N ATR', 'N pips', or 'N ticks' as a stop/target distance."""
    lowered = text.lower()
    atr = re.search(r"(\d+(?:\.\d+)?)\s*(?:x\s*)?atr", lowered)
    if atr:
        return {"type": "atr", "value": float(atr.group(1))}, True
    pips = re.search(r"(\d+(?:\.\d+)?)\s*pips?", lowered)
    if pips:
        return {"type": "pips", "value": float(pips.group(1))}, True
    ticks = re.search(r"(\d+(?:\.\d+)?)\s*ticks?", lowered)
    if ticks:
        return {"type": "ticks", "value": float(ticks.group(1))}, True
    return None


def _extract_risk_section(text: str, stop_label: str, take_label: str) -> str:
    """Isolate the risk clause around a stop-loss / take-profit label."""
    lowered = text.lower()
    stop_index = lowered.find(stop_label)
    take_index = lowered.find(take_label)
    if stop_index < 0 and take_index < 0:
        return ""
    start = stop_index if stop_index >= 0 else take_index
    end = take_index if take_index >= 0 else stop_index
    if end < start:
        end = len(text)
    # Grab a bounded window around the first label, plus any other label inside it.
    start = max(0, start - 4)
    end = min(len(text), end + 40)
    return text[start:end]


def parse_risk(text: str) -> dict[str, Any]:
    """Parse stop-loss, take-profit, and lot sizing from a prompt."""
    stop_explicit = False
    take_explicit = False
    stop_loss: dict[str, Any] = dict(_DEFAULT_STOP_LOSS)
    take_profit: dict[str, Any] = dict(_DEFAULT_TAKE_PROFIT)

    if "stop loss" in text.lower() or "sl" in re.split(r"\W+", text.lower()):
        clause = _extract_risk_section(text, "stop loss", "take profit")
        parsed = _parse_distance(clause, "stop loss")
        if parsed:
            stop_loss, stop_explicit = parsed

    if "take profit" in text.lower() or re.search(r"\btp\b", text.lower()):
        clause = _extract_risk_section(text, "take profit", "stop loss")
        parsed = _parse_distance(clause, "take profit")
        if parsed:
            take_profit, take_explicit = parsed

    lot_sizing: dict[str, Any] = dict(_DEFAULT_LOT_SIZING)
    lots_explicit = False
    lots = re.search(r"(\d+(?:\.\d+)?)\s*(?:standard\s*)?lots?", text.lower())
    if lots:
        lot_sizing = {"type": "fixed", "lots": float(lots.group(1))}
        lots_explicit = True
    risk_pct = re.search(r"risk\s*(\d+(?:\.\d+)?)\s*%", text.lower())
    if risk_pct:
        lot_sizing = {"type": "risk_fraction", "fraction": float(risk_pct.group(1)) / 100.0}
        lots_explicit = True

    return {
        "stop_loss": stop_loss,
        "take_profit": take_profit,
        "lot_sizing": lot_sizing,
        "units_per_lot": UNITS_PER_LOT,
        "explicit": {
            "stop_loss": stop_explicit,
            "take_profit": take_explicit,
            "lot_sizing": lots_explicit,
        },
    }


def parse_execution(text: str) -> dict[str, Any]:
    """Parse slippage, spread handling, and commission from a prompt."""
    lowered = text.lower()
    slippage: dict[str, Any] = dict(_DEFAULT_SLIPPAGE)
    slippage_match = re.search(r"slippage\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(pips?|ticks?|points?)", lowered)
    if slippage_match:
        value = float(slippage_match.group(1))
        unit = slippage_match.group(2)
        points = value * _TICKS_PER_PIP if unit.startswith("pip") else value
        slippage = {"type": "points", "value": points}

    if re.search(r"\bfixed\s*spread\b", lowered):
        spread = "fixed"
    else:
        spread = "variable"

    commission: dict[str, Any] = dict(_DEFAULT_COMMISSION)
    commission_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:usd\s*)?per\s*lot", lowered)
    if commission_match:
        commission = {"usd_per_lot_per_side": float(commission_match.group(1))}

    return {"slippage": slippage, "spread": spread, "commission": commission}


def _parse_sma_rule(text: str) -> dict[str, Any]:
    params = re.search(r"\bsma\s*\(?\s*(\d+)\s*,\s*(\d+)", text.lower())
    if params:
        fast, slow = int(params.group(1)), int(params.group(2))
    else:
        fast, slow = 10, 30
    return {"type": "sma_cross", "fast": fast, "slow": slow}


def _parse_breakout_rule(text: str) -> dict[str, Any]:
    params = re.search(r"(?:breakout|donchian|channel)\s*\(?\s*(\d+)", text.lower())
    return {"type": "breakout", "period": int(params.group(1)) if params else 20}


def _parse_rsi_rule(text: str) -> dict[str, Any]:
    params = re.search(r"\brsi\s*\(?\s*(\d+)", text.lower())
    return {"type": "rsi_zone", "period": int(params.group(1)) if params else 14}


def parse_hypothesis(text: str) -> dict[str, Any]:
    """Parse entry rules (and exit policy) from a prompt."""
    entry: list[dict[str, Any]] = []
    for rule_type, pattern in _RULE_PATTERNS:
        if pattern.search(text):
            if rule_type == "sma_cross":
                entry.append(_parse_sma_rule(text))
            elif rule_type == "breakout":
                entry.append(_parse_breakout_rule(text))
            else:
                entry.append(_parse_rsi_rule(text))
    if not entry:
        entry.append(_parse_sma_rule(text))
    exit_rules: list[dict[str, Any]] = [{"type": "flat_on_flip"}]
    return {"entry": entry, "exit": exit_rules}


def idea_to_spec(prompt: str, *, defaults: dict[str, Any] | None = None) -> dict[str, Any]:
    """Translate a trader prompt into a deterministic, validated StrategySpec.

    Every field the prompt does not state is filled from a documented default
    and recorded in ``spec["assumptions"]`` so the caller can review what was
    inferred before executing any backtest code.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be a non-empty string")

    symbol, symbol_explicit = parse_symbol(prompt)
    timeframe, timeframe_explicit = parse_timeframe(prompt)
    asset_class, asset_class_explicit = parse_asset_class(prompt)
    risk = parse_risk(prompt)
    execution = parse_execution(prompt)
    hypothesis = parse_hypothesis(prompt)

    stop_loss = risk["stop_loss"]
    take_profit = risk["take_profit"]
    lot_sizing = risk["lot_sizing"]
    assumptions: list[str] = []
    if not symbol_explicit:
        assumptions.append(f"symbol: defaulted to {symbol} (not specified)")
    if not timeframe_explicit:
        assumptions.append(f"timeframe: defaulted to {timeframe} (not specified)")
    if not asset_class_explicit:
        assumptions.append(f"asset_class: defaulted to {asset_class} (not specified)")
    if not risk["explicit"]["stop_loss"]:
        assumptions.append(
            f"stop_loss: defaulted to {stop_loss['value']}x ATR (not specified)"
        )
    if not risk["explicit"]["take_profit"]:
        assumptions.append(
            f"take_profit: defaulted to {take_profit['value']}x ATR (not specified)"
        )
    if not risk["explicit"]["lot_sizing"]:
        assumptions.append(
            "lot_sizing: defaulted to fixed 1.0 standard lot (100k units) (not specified)"
        )
    if execution["spread"] == "variable":
        assumptions.append("spread: variable spread model (bid/ask from data or synthesized from close)")
    assumption_prefix = "entry: " + ", ".join(
        f"{rule['type']}({','.join(str(rule[k]) for k in rule if k != 'type')})" for rule in hypothesis["entry"]
    )
    assumptions.append(assumption_prefix)

    spec: dict[str, Any] = {
        "asset_class": asset_class,
        "symbol": symbol,
        "timeframe": timeframe,
        "hypothesis": hypothesis,
        "risk_model": {
            "stop_loss": stop_loss,
            "take_profit": take_profit,
            "lot_sizing": lot_sizing,
            "units_per_lot": UNITS_PER_LOT,
        },
        "execution_model": {
            "slippage": execution["slippage"],
            "spread": execution["spread"],
            "commission": execution["commission"],
        },
        "assumptions": _dedupe(assumptions),
    }
    if defaults:
        spec = {**defaults, **{key: value for key, value in spec.items() if key != "assumptions"}}
        spec["assumptions"] = _dedupe([*assumptions, *[str(a) for a in (defaults.get("assumptions") or [])]])
    return spec


def normalize_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Validate and coerce a programmatically-built spec dict to the canonical shape."""
    if not isinstance(spec, dict):
        raise ValueError("spec must be a dict")
    if not isinstance(spec.get("symbol"), str) or not spec["symbol"]:
        raise ValueError("spec.symbol is required")
    if not isinstance(spec.get("timeframe"), str) or not spec["timeframe"]:
        raise ValueError("spec.timeframe is required")
    hypothesis = spec.get("hypothesis")
    if not isinstance(hypothesis, dict) or not isinstance(hypothesis.get("entry"), list) or not hypothesis["entry"]:
        raise ValueError("spec.hypothesis.entry must be a non-empty list of rules")
    risk_model = spec.get("risk_model")
    if not isinstance(risk_model, dict):
        raise ValueError("spec.risk_model is required")
    execution_model = spec.get("execution_model")
    if not isinstance(execution_model, dict):
        raise ValueError("spec.execution_model is required")
    normalized = {
        "asset_class": spec.get("asset_class", ASSET_CLASS_FOREX),
        "symbol": spec["symbol"].upper(),
        "timeframe": str(spec["timeframe"]).upper(),
        "hypothesis": hypothesis,
        "risk_model": risk_model,
        "execution_model": execution_model,
        "assumptions": [str(a) for a in (spec.get("assumptions") or [])],
    }
    return normalized


def assumptions(spec: dict[str, Any]) -> str:
    """Render the explicit assumptions behind a spec as a printable bullet list."""
    items = spec.get("assumptions") or []
    lines = ["assumptions:"]
    if items:
        lines.extend(f"- {item}" for item in items)
    else:
        lines.append("- none recorded")
    return "\n".join(lines)


__all__ = [
    "ASSET_CLASS_CFD",
    "ASSET_CLASS_FOREX",
    "UNITS_PER_LOT",
    "assumptions",
    "idea_to_spec",
    "normalize_spec",
    "parse_asset_class",
    "parse_execution",
    "parse_hypothesis",
    "parse_risk",
    "parse_symbol",
    "parse_timeframe",
]
