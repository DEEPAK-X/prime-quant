# 02 — API Contract (FROZEN, v2)

This document is the single source of truth for the bridge ↔ GUI interface.
Both agents implement against it. **Changing it requires written agreement from
both agents (GitHub issue comment) — do not silently extend it.**

Transport: HTTP + WebSocket, same origin (GUI dev server proxies to the bridge).

- Bridge origin: `http://127.0.0.1:3001`
- WebSocket path: `/ws`
- All REST paths are prefixed `/api`
- All timestamps are ISO-8601 UTC strings
- Every event/object is JSON

Versioning: the bridge sends a `hello` event on connect carrying
`"protocol": 2`. A GUI that receives `"protocol": 1` (demo backend) runs in
demo mode with reduced features.

## Relationship to the existing Phase 8A surfaces

`packages/web-ui-server/src/gui-bridge.ts` (commit `c8a080bb`) already exposes
`POST /api/chat` (NDJSON), `WS /ws/events`, `GET /api/artifacts/serve`, and
`SCREAMING_SNAKE_CASE` events (`SUBAGENT_SPAWNED`, `PIPELINE_STEP_UPDATE`,
`ARTIFACT_READY`). Disposition:

- **GUI-facing surface is this v2 contract only** (`/ws`, `/api/*`, lowercase
  event names). The GUI must never consume `/ws/events` or `/api/chat`.
- `resolveArtifactPath` (traversal-safe) is reused internally to implement
  `GET /reports/<file>`; `/api/artifacts/serve` may remain as a utility.
- The legacy `/api/chat` NDJSON route and `/ws/events` may stay during
  migration (their tests must keep passing) but are removed at the
  integration milestone (05 §cleanup) once v2 covers them.

---

## 1. WebSocket: server → client events

### 1.1 `hello` (first event after connect)

```json
{
  "type": "hello",
  "protocol": 2,
  "backend": "bridge" | "demo",
  "agentState": "starting" | "ready" | "busy" | "error" | "stopped",
  "sessionId": "gui-session" | null,
  "mt5": { "status": "ok" | "down" | "unknown", "detail": { "server": "XMGlobal-MT5 6", "login": 1301549953, "symbols": 1640 }, "checkedAt": "2026-08-17T12:00:00Z" }
}
```

`mt5.detail` may be `null` when status is not `"ok"`. The bridge probes MT5 at
most once per 30 s (cache + in-flight dedupe) — see 03 §M4.

### 1.2 `agent_state`

```json
{ "type": "agent_state", "state": "starting" | "ready" | "busy" | "error" | "stopped", "detail": "..." }
```

- `starting`: RPC child spawning / booting kernel
- `ready`: idle, accepting prompts
- `busy`: a turn is streaming
- `error`: child crashed or RPC protocol error (auto-restart pending)
- `stopped`: intentionally shut down

### 1.3 `chat` (complete message)

```json
{ "type": "chat", "role": "user" | "assistant", "text": "string (markdown)", "id": "a1b2", "ts": "2026-08-17T12:00:00Z" }
```

Complete, final text. The GUI appends the user message optimistically on send;
the bridge MUST echo user messages with the same `text` — the GUI dedupes by
matching the last optimistic user message (existing behavior, keep).

### 1.4 `chat_delta` (streaming, assistant only)

```json
{ "type": "chat_delta", "id": "a1b2", "delta": "chunk of markdown text" }
```

Zero or more per assistant message, always followed by one `chat` with the
final full text and the same `id`. The GUI accumulates deltas into a live
message and replaces it with the final `chat`.

### 1.5 `thinking` (reasoning trace, collapsible)

```json
{ "type": "thinking", "id": "t1", "delta": "chunk", "done": false }
{ "type": "thinking", "id": "t1", "delta": "final chunk", "done": true }
```

Rendered as a collapsed "Reasoning" accordion above the assistant message.

### 1.6 `step` (pipeline stage)

```json
{ "type": "step", "id": "run-42-backtest", "name": "ast_check" | "backtest" | "cpcv_gate" | "optimize" | "tearsheet" | "fetch_data", "status": "running" | "done" | "error", "detail": "dsr 1.32 · pbo 0.11" }
```

Names beyond the original three are legal: the GUI renders unknown names as a
title-cased label. `id` groups updates of one stage instance.

### 1.7 `subagent`

```json
{ "type": "subagent", "id": "sub-1", "name": "worker://eurusd-m5-scan", "tier": "worker", "status": "RUNNING" | "DONE" | "ERROR", "tokensPerMin": 12400, "task": "param sweep: …" }
```

Upsert by `id`. `tokensPerMin` and `task` are optional.

### 1.8 `tearsheet`

```json
{ "type": "tearsheet", "url": "/reports/tearsheet_EURUSD_M5.html", "name": "tearsheet_EURUSD_M5.html", "ts": "…" }
```

`url` is served by the bridge (section 3). If `name`/`ts` are unknown the
bridge omits them.

### 1.9 `artifact`

```json
{ "type": "artifact", "kind": "py" | "mq5" | "md", "name": "eurusd_m5_mean_reversion.py", "content": "full file content" }
```

Upsert by `name` within `kind`.

### 1.10 `card` (quant summary card)

```json
{ "type": "card", "id": "c1", "title": "Backtest · EURUSD M5", "payload": { "status": "success", "metrics": { "sharpe_ratio": 1.84 }, "validation_gate": { "passed": true } } }
```

Emitted when a chat/tool payload is detected to be a quant JSON card
(content-type sniffing rules in 03 §M3). The GUI renders it as a metric grid,
never as raw JSON.

### 1.11 `error`

```json
{ "type": "error", "scope": "agent" | "bridge" | "mt5" | "protocol", "message": "human-readable", "fatal": false }
```

`fatal: true` means the user must act (e.g. no provider login).

---

## 2. WebSocket: client → server

### 2.1 `chat`

```json
{ "type": "chat", "text": "Analyse EURUSD M5 sma cross" }
```

Bridge forwards to RPC as `{"type":"prompt","message":<text>}`. If the agent
is busy, the bridge resends with `"streamingBehavior":"followUp"` (spec: rpc.md
§Prompting). Empty/whitespace text is ignored.

### 2.2 `interrupt`

```json
{ "type": "interrupt" }
```

Bridge sends the RPC `interrupt` command; maps to agent turn abort.

### 2.3 `refresh_mt5`

```json
{ "type": "refresh_mt5" }
```

Forces an MT5 probe outside the cache window. Response arrives as a `hello`
event with fresh `mt5` data (bridge may send `hello` again; the GUI treats
`hello` as a full state snapshot merge, never a chat reset).

---

## 3. REST endpoints

| Method | Path | Response |
|---|---|---|
| GET | `/api/health` | `{ "ok": true, "backend": "bridge", "agentState": "ready" }` |
| GET | `/api/subagents` | `{ "subagents": [SubagentEvent…] }` (current upsert state) |
| GET | `/api/artifacts?kind=py\|mq5\|md` | `{ "artifacts": [ArtifactEvent…] }` |
| GET | `/api/tearsheet/latest` | `{ "url": "/reports/…", "name": "…", "ts": "…" }` or `204` |
| GET | `/api/tearsheets` | `{ "tearsheets": [{ "url": "…", "name": "…", "ts": "…" }] }` newest first |
| GET | `/reports/<file>` | The tearsheet HTML file, `content-type: text/html`. Path-traversal safe: reject any `<file>` containing `..`, `/`, or `\` after decoding |
| GET | `/api/mt5` | Same shape as `hello.mt5` |

404 shape: `{ "error": "not found" }`. 405 for wrong method on a known path.

Error semantics: REST never crashes the bridge; WS push is the source of
truth, REST snapshots are conveniences for initial paint / reconnect merge.

---

## 4. Event ordering guarantees

1. `hello` is always the first event after socket open.
2. A `chat_delta` stream is never interleaved with another `chat_delta`
   stream of a different `id`; `thinking` blocks may interleave.
3. The final `chat` for id X arrives after all `chat_delta` X events.
4. `step` events with the same `id` arrive in status order
   `running → done | error`.
5. On bridge restart the GUI reconnects (existing exponential backoff in
   `ws.ts` stays) and re-fetches all REST snapshots.

## 5. Demo backend compatibility

`demo-backend.mjs` speaks protocol v1 (no `hello`, no `chat_delta`/`thinking`/
`card`/`agent_state`, no `/api/health`). The GUI:

- runs unchanged against it (v1 events still render),
- hides MT5 status, streaming cursors, and thinking accordions,
- shows a "DEMO" badge when no `hello.protocol === 2` arrives within 2 s.
