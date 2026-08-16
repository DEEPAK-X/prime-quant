"""Fail-and-refine: durable failure-pattern telemetry for the /refine loop.

When a backtest, validation gate, or AST lint pass fails, ``refine_log_failure``
records the specific failure pattern into the continual harness
(``rlm.harness``) as a memory plus a refinement event, so future generation
cycles do not repeat the same structural mistake. Logging is idempotent per
pattern: re-logging the same failure bumps the entry version instead of
creating a duplicate.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

FAILURE_PATH = "quant/failures"

_AST_RULES = (
    "future-shift",
    "future-index",
    "signal-lag",
    "global-normalization",
    "split-leakage",
)
_OVERFIT_MARKERS = ("pbo", "deflated sharpe", "deflated_sharpe", "overfit", "walk-forward", "oos")


def _classify_failure(text: str) -> str:
    lowered = text.lower()
    for rule in _AST_RULES:
        if rule in lowered:
            return "ast_lint"
    if any(marker in lowered for marker in _OVERFIT_MARKERS):
        return "validation_gate"
    return "backtest_error"


def _normalize_pattern(failure: dict[str, Any] | str) -> tuple[str, str, str]:
    """Return (kind, pattern, summary) for a failure."""
    if isinstance(failure, dict):
        kind = str(failure.get("kind") or _classify_failure(str(failure.get("pattern") or "")))
        pattern = str(failure.get("pattern") or failure.get("message") or json.dumps(failure, sort_keys=True))
        summary = str(failure.get("summary") or failure.get("message") or pattern)
    else:
        text = str(failure).strip()
        kind = _classify_failure(text)
        pattern = re.sub(r"\s+", " ", text)
        summary = pattern
    return kind, pattern[:400], summary[:400]


def _memory_id(kind: str, pattern: str) -> str:
    digest = hashlib.sha1(f"{kind}:{pattern}".encode("utf-8")).hexdigest()[:12]
    return f"quant_failure_{digest}"


def _default_harness() -> Any:
    try:
        import rlm

        return rlm.harness
    except Exception as exc:  # noqa: BLE001 - rlm may be unavailable outside a kernel
        raise RuntimeError(
            "rlm.harness is unavailable; pass harness= explicitly or run inside the Prime Agent kernel"
        ) from exc


def refine_log_failure(
    failure: dict[str, Any] | str,
    *,
    context: str | None = None,
    trigger: str | None = None,
    global_: bool = False,
    harness: Any = None,
) -> dict[str, Any]:
    """Record a failure pattern into harness memory for the /refine loop.

    - ``failure``: a dict (``kind``/``pattern``/``summary``) or a raw error
      string; the kind is auto-classified (``ast_lint``, ``validation_gate``,
      ``backtest_error``) when not given.
    - ``context``: optional extra detail (e.g. the strategy spec or rule name)
      appended to the memory entry so future cycles know where the mistake
      happened.
    - ``trigger``: the refinement trigger label; defaults to ``quant:<kind>``.
    - ``global_``: persist to the cross-session global harness store.
    - ``harness``: harness store to write to (defaults to ``rlm.harness``).

    Returns ``{status, kind, memory_id, refinement_id, duplicate, version}``.
    """
    kind, pattern, summary = _normalize_pattern(failure)
    state = harness if harness is not None else _default_harness()

    memory_id = _memory_id(kind, pattern)
    title = f"quant {kind} failure"
    content = f"[{kind}] {pattern}"
    if context:
        content = f"{content}\ncontext: {str(context)[:300]}"
    existing = None
    try:
        existing = state.get("memory", memory_id, global_=global_)
    except Exception:  # noqa: BLE001 - a missing entry or store quirk is not fatal
        existing = None
    duplicate = existing is not None

    entry = state.upsert(
        "memory",
        title,
        content,
        id=memory_id,
        path=FAILURE_PATH,
        metadata={"kind": kind, "source": "quant-refine", "pattern": pattern},
        global_=global_,
    )

    try:
        event = state.record_refinement(
            trigger=trigger or f"quant:{kind}",
            changes=[f"logged {kind} failure pattern to avoid repetition"],
            evidence=summary,
            outcome="logged" if not duplicate else "updated",
            global_=global_,
        )
        refinement_id = event.id
    except Exception:  # noqa: BLE001 - the memory entry is the durable part
        refinement_id = None

    return {
        "status": "logged",
        "kind": kind,
        "memory_id": memory_id,
        "refinement_id": refinement_id,
        "duplicate": duplicate,
        "version": getattr(entry, "version", 1),
    }


__all__ = [
    "FAILURE_PATH",
    "refine_log_failure",
]
