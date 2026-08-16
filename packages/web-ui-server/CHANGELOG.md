# Changelog

## [Unreleased]

- Added the `@earendil-works/pi-web-ui-server` package: a local HTTP + WebSocket bridge (`localhost:3001`) exposing an interactive Prime Agent session to a web GUI, with `POST /api/chat` (NDJSON response streaming), `WS /ws/events` broadcasting structured subagent/pipeline/artifact events, and `GET /api/artifacts/serve` with path-traversal guards. The bridge subscribes to the session event stream on its own and never blocks the IPython runtime.
