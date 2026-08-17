# Changelog

## [Unreleased]

- Added the `@earendil-works/pi-web-ui-server` package: a local HTTP + WebSocket bridge (`localhost:3001`) exposing an interactive Prime Agent session to a web GUI, with `POST /api/chat` (NDJSON response streaming), `WS /ws/events` broadcasting structured subagent/pipeline/artifact events, and `GET /api/artifacts/serve` with path-traversal guards. The bridge subscribes to the session event stream on its own and never blocks the IPython runtime.
- Added a real RPC subprocess backend: the bridge now spawns the coding agent in `--mode rpc` (Windows-safe `process.execPath` + tsx spawn, strict LF-only JSONL reader) behind the existing `BridgeSession` interface, with prompt correlation, follow-up queuing while streaming, and restart-on-exit with capped backoff.
- Added the GUI v2 contract surface (`WS /ws` with `hello` first frame, `agent_state`/`chat`/`chat_delta`/`thinking`/`step`/`subagent`/`tearsheet`/`artifact`/`card`/`error` broadcasts, client `chat`/`interrupt`/`refresh_mt5`, and REST snapshots at `/api/health`, `/api/subagents`, `/api/artifacts`, `/api/tearsheet/latest`, `/api/tearsheets`, `/api/mt5`, `/reports/<file>`) backed by a single in-memory state store.
- Added RPC event translation to v2 events: streamed `chat_delta`/`thinking`, pipeline `step` chips derived from ipython cells, `subagent` upserts from `rlm_child_update`, compaction steps, and quant JSON `card` sniffing.
- Added a tearsheet registry and artifact scanner: HTML reports written by tool runs are watched (debounced, with polling fallback) and broadcast as `tearsheet` events served from `/reports/<file>`; generated `.py`/`.mq5`/`.md` files are surfaced as capped `artifact` events.
- Added a throttled read-only MetaTrader 5 health probe (kernel-venv python, 30 s cache, in-flight dedupe, 10 s timeout) exposed via `/api/mt5`, the `hello` frame, and WS `refresh_mt5`.
- Added `npm run server` (bridge alone), `npm run server:demo` (demo backend), and `npm run gui:live` (Vite GUI + bridge) root scripts.
