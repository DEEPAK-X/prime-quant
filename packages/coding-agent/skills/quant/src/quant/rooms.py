"""Bridge rooms integration for quant skills.

Dispatches notifications from watcher agents and pipeline runs to named rooms
channels on the PRIME QUANT bridge (default http://127.0.0.1:3001, overridable
via PRIME_QUANT_BRIDGE_URL). All posts are strictly best-effort and fail silently
so network / bridge issues never block backtests or pipeline execution.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

DEFAULT_BRIDGE_URL = "http://127.0.0.1:3001"
BRIDGE_URL_ENV = "PRIME_QUANT_BRIDGE_URL"
DEFAULT_TIMEOUT_SECONDS = 1.0


def get_bridge_url() -> str:
    """Return the active bridge base URL, stripped of trailing slashes."""
    return os.environ.get(BRIDGE_URL_ENV, DEFAULT_BRIDGE_URL).rstrip("/")


def post_room_message(
    room_id: str,
    text: str,
    from_sender: str = "watcher://pipeline",
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> bool:
    """Post a message to a named room on the bridge.

    Fails silently on any network, timeout, HTTP, or serialization error.
    Returns True if the bridge returned HTTP 2xx, False otherwise.
    """
    try:
        base_url = get_bridge_url()
        url = f"{base_url}/api/rooms/{room_id}/messages"
        payload = json.dumps({"from": from_sender, "text": text}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return 200 <= response.status < 300
    except Exception:  # noqa: BLE001 - best effort, never raise or block pipeline
        return False


def post_tearsheet_to_research(
    report_dict: dict[str, Any],
    symbol: str = "",
    timeframe: str = "",
) -> bool:
    """Post a tearsheet completion notice into the #research room.

    Message format: 'tearsheet <name>: <report_path> (<size_kb> KB)'
    Fails silently if report_dict has no path or bridge is unreachable.
    """
    try:
        report_path = report_dict.get("report_path")
        if not report_path or not isinstance(report_path, str):
            return False

        name = os.path.basename(report_path)
        if not name:
            name = f"tearsheet_{symbol}_{timeframe}.html" if symbol and timeframe else "tearsheet.html"

        size_kb = report_dict.get("file_size_kb", 0)
        text = f"tearsheet {name}: {report_path} ({size_kb} KB)"
        return post_room_message(
            room_id="research",
            text=text,
            from_sender="watcher://pipeline",
        )
    except Exception:  # noqa: BLE001 - best effort, fail silently
        return False
