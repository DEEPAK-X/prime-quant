# web-ui Changelog

## [Unreleased]

- Added the v2 protocol contract layer (`src/lib/contract.ts`) with full `ServerEvent`/`ClientMessage`/`AgentState`/`ArtifactStore`/`ValidationGate` types, plus pure upsert and event-guard helpers.
- Added a `MockSocket` (`src/lib/mock-socket.ts`) that replays recorded v2 event scripts for offline development, activated via `?mock=1`; real connections stay on the `/ws` WebSocket.
- Added a pure chat-stream reducer (`src/lib/reducer.ts`) for `chat_delta` accumulation, finalized `chat` replacement with optimistic-user dedupe, and `thinking` block tracking, with a vitest unit suite (`test/reducer.test.ts`).
- Rewrote the socket store (`src/lib/ws.ts`) onto the v2 contract: rAF-batched delta flushing, agent-state/MT5/tearsheet/subagent/artifact state, demo-mode detection with a DEMO badge, and a `QuantStoreProvider` context (`src/lib/store.tsx`).
- Added a `TopBar` showing protocol (v2/DEMO), agent-state pill, MT5 status, and connection state with an artifact-pane toggle.
- Added a left session `Sidebar` with stats (runs, verdict, tearsheets) and session list.
- Restructured `App.tsx` into a three-column shell (sidebar, chat, collapsible artifact pane) with `localStorage`-persisted pane state and a narrow-viewport collapse.
- Added dark-terminal design tokens, a streaming cursor animation, and a Cascadia Code font stack to `src/index.css`.
- Added the minimalist split-pane terminal GUI: conversational orchestrator chat with pipeline step indicators, a live sub-agent monitor, an embedded HTML tearsheet viewer, and a `.py` / `.mq5` export drawer.
- Added `npm run gui` at the repo root, which starts the Vite dev server proxying `/api`, `/reports`, `/artifacts`, and `/ws` to the quant backend on `localhost:3001`.
