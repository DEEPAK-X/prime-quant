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


def recall_failures(
    *,
    kind: str | None = None,
    global_: bool = False,
    harness: Any = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Recall quant failure memories before generating a new strategy.

    The read counterpart to :func:`refine_log_failure`: it returns the failure
    patterns previously logged into the harness so the generation step can
    avoid repeating known dead-ends. This closes the fail-and-refine loop:
    failures are recorded by ``refine_log_failure`` and recalled here before
    the next idea is turned into a strategy.

    - ``kind``: filter by failure kind (``ast_lint`` / ``validation_gate`` /
      ``backtest_error``); ``None`` returns all quant failures.
    - ``global_``: read from the cross-session global harness store.
    - ``harness``: harness store to read from (defaults to ``rlm.harness``).
    - ``limit``: cap the number of returned failures (highest-version first).

    Returns ``{status, count, failures, prompt_block}``. ``prompt_block`` is a
    short, ready-to-inject string summarising the known dead-ends so the agent
    can fold it into its next strategy-generation prompt. An empty harness
    yields ``count == 0`` and an empty ``prompt_block`` rather than raising.
    """
    state = harness if harness is not None else _default_harness()

    try:
        entries = state.list("memory", global_=global_)
    except Exception as exc:  # noqa: BLE001 - a missing store should not crash generation
        raise RuntimeError(
            "rlm.harness is unavailable; pass harness= explicitly or run inside the Prime Agent kernel"
        ) from exc

    failures: list[dict[str, Any]] = []
    for entry in entries:
        if not entry.id.startswith(_MEMORY_ID_PREFIX):
            continue
        if entry.path != FAILURE_PATH:
            continue
        entry_kind = entry.metadata.get("kind") if isinstance(entry.metadata, dict) else None
        if kind is not None and entry_kind != kind:
            continue
        pattern = entry.metadata.get("pattern") if isinstance(entry.metadata, dict) else None
        pattern = pattern or _pattern_from_content(entry.content)
        failures.append(
            {
                "kind": entry_kind or "unknown",
                "pattern": pattern,
                "summary": _summary_from_content(entry.content),
                "version": getattr(entry, "version", 1),
            }
        )

    # Most-recurrent first: a high version means the same mistake kept coming
    # back and deserves extra emphasis in the generation prompt.
    failures.sort(key=lambda item: item["version"], reverse=True)
    if limit is not None and limit >= 0:
        failures = failures[:limit]

    prompt_block = _build_prompt_block(failures)
    return {
        "status": "recalled",
        "count": len(failures),
        "failures": failures,
        "prompt_block": prompt_block,
    }


_MEMORY_ID_PREFIX = "quant_failure_"


def _pattern_from_content(content: str) -> str:
    # ``refine_log_failure`` writes ``"[{kind}] {pattern}"`` as the content.
    text = content.strip()
    if text.startswith("["):
        bracket = text.find("]")
        if bracket != -1:
            return text[bracket + 1 :].strip()
    return text


def _summary_from_content(content: str) -> str:
    pattern = _pattern_from_content(content)
    context_marker = "\ncontext:"
    idx = pattern.find(context_marker)
    if idx != -1:
        return pattern[:idx].strip()
    return pattern


def _build_prompt_block(failures: list[dict[str, Any]]) -> str:
    if not failures:
        return ""
    lines = [
        "Known failure patterns previously logged to the harness — do NOT repeat them:",
    ]
    for index, item in enumerate(failures, start=1):
        recurrence = f" (recurring x{item['version']})" if item["version"] > 1 else ""
        lines.append(f"{index}. [{item['kind']}] {item['pattern']}{recurrence}")
    return "\n".join(lines)


__all__ = [
    "FAILURE_PATH",
    "refine_log_failure",
    "recall_failures",
]
