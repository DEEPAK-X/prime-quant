"""Tests for quant skill bridge rooms dispatch helper."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
from typing import Any

import pytest

from quant.rooms import (
    BRIDGE_URL_ENV,
    get_bridge_url,
    post_room_message,
    post_tearsheet_to_research,
)
from quant.runner import run_pipeline
from tests._fxdata import synthetic_fx


class _FakeBridgeHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len) if content_len > 0 else b""
        payload = json.loads(body.decode("utf-8")) if body else {}

        self.server.requests.append(  # type: ignore[attr-defined]
            {
                "path": self.path,
                "headers": dict(self.headers),
                "payload": payload,
            }
        )

        if getattr(self.server, "fail_mode", False):  # type: ignore[attr-defined]
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{"error":"internal"}')
            return

        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass  # Quiet down test output


@pytest.fixture
def fake_bridge():
    server = HTTPServer(("127.0.0.1", 0), _FakeBridgeHandler)
    server.requests = []  # type: ignore[attr-defined]
    server.fail_mode = False  # type: ignore[attr-defined]
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server, f"http://127.0.0.1:{port}"
    server.shutdown()
    server.server_close()


def test_get_bridge_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(BRIDGE_URL_ENV, raising=False)
    assert get_bridge_url() == "http://127.0.0.1:3001"

    monkeypatch.setenv(BRIDGE_URL_ENV, "http://localhost:4500/")
    assert get_bridge_url() == "http://localhost:4500"


def test_post_room_message_success(fake_bridge, monkeypatch: pytest.MonkeyPatch) -> None:
    server, base_url = fake_bridge
    monkeypatch.setenv(BRIDGE_URL_ENV, base_url)

    ok = post_room_message(
        room_id="research",
        text="tearsheet report.html: /tmp/report.html (45 KB)",
        from_sender="watcher://pipeline",
    )

    assert ok is True
    assert len(server.requests) == 1
    req = server.requests[0]
    assert req["path"] == "/api/rooms/research/messages"
    assert req["payload"] == {
        "from": "watcher://pipeline",
        "text": "tearsheet report.html: /tmp/report.html (45 KB)",
    }


def test_post_tearsheet_to_research(fake_bridge, monkeypatch: pytest.MonkeyPatch) -> None:
    server, base_url = fake_bridge
    monkeypatch.setenv(BRIDGE_URL_ENV, base_url)

    report_dict = {
        "report_path": "reports/tearsheet_EURUSD_M5.html",
        "file_size_kb": 128,
    }
    ok = post_tearsheet_to_research(report_dict, symbol="EURUSD", timeframe="M5")

    assert ok is True
    assert len(server.requests) == 1
    req = server.requests[0]
    assert req["path"] == "/api/rooms/research/messages"
    assert req["payload"]["from"] == "watcher://pipeline"
    assert req["payload"]["text"] == "tearsheet tearsheet_EURUSD_M5.html: reports/tearsheet_EURUSD_M5.html (128 KB)"


def test_post_room_message_silent_failure_on_500(fake_bridge, monkeypatch: pytest.MonkeyPatch) -> None:
    server, base_url = fake_bridge
    server.fail_mode = True
    monkeypatch.setenv(BRIDGE_URL_ENV, base_url)

    ok = post_room_message("research", "some message")
    assert ok is False


def test_post_room_message_silent_failure_on_unreachable_server(monkeypatch: pytest.MonkeyPatch) -> None:
    # Dial an unreachable port
    monkeypatch.setenv(BRIDGE_URL_ENV, "http://127.0.0.1:59999")
    ok = post_room_message("research", "some message", timeout=0.2)
    assert ok is False


def test_post_tearsheet_missing_path() -> None:
    assert post_tearsheet_to_research({}) is False
    assert post_tearsheet_to_research({"report_path": None}) is False


@pytest.mark.asyncio
async def test_run_pipeline_dispatches_tearsheet_to_research(
    fake_bridge,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, base_url = fake_bridge
    monkeypatch.setenv(BRIDGE_URL_ENV, base_url)

    df = synthetic_fx(n_bars=150)
    out_html = str(tmp_path / "tearsheet_test.html")

    raw_card = await run_pipeline(
        "EURUSD M5 sma cross",
        data=df,
        report_path=out_html,
    )

    card = json.loads(raw_card)
    assert card["status"] == "success"
    assert "report_path" in card["report"]

    # Verify that the fake bridge received the tearsheet dispatch
    assert len(server.requests) >= 1
    req = server.requests[-1]
    assert req["path"] == "/api/rooms/research/messages"
    assert req["payload"]["from"] == "watcher://pipeline"
    assert "tearsheet_test.html" in req["payload"]["text"]
