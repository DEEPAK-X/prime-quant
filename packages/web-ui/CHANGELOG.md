# web-ui Changelog

## [Unreleased]

- Added the rooms model (contract amendment §6): `rooms_state` and `room_message` events, per-client `subscribe` filtering, bounded per-room logs (200 messages), and REST endpoints `GET /api/rooms`, `GET|POST /api/rooms/:id/messages` for watcher intake. Rooms view now switches between live rooms, the command rail surfaces room mentions, and the demo backend and `?mock=1` replay seed watcher posts.
- Reworked the GUI into the PRIME QUANT OS shell: a left nav rail (Dashboard, Agents, Rooms, Trading Bots, Training Room, and M2+ placeholders), a top status bar (mode badge, agent state, MT5 pill with click-to-reprobe, WS state, live clock, rail toggle), and a right command rail (agents online, mentions, shared files, pinned). Hash-based view routing (`#/rooms`, `#/dashboard`, ...) so refresh and back/forward keep the view.
- Added a Dashboard view (system tiles, latest tearsheet, recent quant cards, recent errors), an Agents view (virtualized roster table), a Trading Bots view (tearsheet, pipeline, artifacts, report history), a Training Room view (optimize/CPCV activity and validation-gate verdicts), and honest milestone-marked placeholders for Knowledge Base, Tasks, Logs, and Settings. The old artifact pane was split across these views; `ArtifactPane.tsx` and `SubagentList.tsx` were removed.
- Retuned the theme to a deep command-center palette (near-black background, mint signal accent) with dot-grid backdrop, corner-tick panel frames, view-switch reveal, and a live status-dot pulse; all animations respect `prefers-reduced-motion`.
- Added `VirtualRows` (fixed-row-height viewport windowing) for large uniform lists; chat stays bounded by the existing 200-message cap.
- Seeded the `?mock=1` offline replay with two watcher sub-agents and a mention so the command rail and Agents view render without a backend.
- Changed the page title to "PRIME QUANT OS".
- Added `StatusToasts.tsx`: a persistent red fatal `error` banner under the topbar, transient auto-dismissing non-fatal error toasts, and a reconnect toast when the WebSocket drops after having been open.
- Added Ctrl/Cmd+Enter as an additional composer send binding and Esc as an interrupt (stop) binding while the agent is busy; the stop button and textarea gained `aria-label`s and the placeholder hints the Esc-to-stop shortcut.
- Added `aria-label`s to the tearsheet reload/open controls and the QuantCard raw-payload toggle, and `role="tab"`/`aria-selected` to the artifact-pane and file-kind tab bars for keyboard a11y.
- Added a non-fatal `error` event to the mock-socket turn script so the error toast is reachable in `?mock=1` mode.
- Fixed the Vite dev proxy dialing `localhost:3001` (which resolves to IPv6 `::1` on Windows) while the bridge binds `127.0.0.1` only, causing intermittent `ECONNREFUSED` on `/api` and `/ws`; the proxy now dials `127.0.0.1:3001`.
- Added an optional `--open` flag to `preview-bridge.mjs` that launches the default browser (Windows-safe via `rundll32 url.dll,FileProtocolHandler`) once the GUI is ready; default off so `npm run gui:live` and CI stay headless.
- Added `QuantCard.tsx` rendering `card` events: a title row, a metric grid (label small-caps / value large), a validation-gate verdict row (PASS green / FAIL red / unknown gray), and a collapsible raw-JSON payload.
- Added `TearsheetView.tsx` (sandboxed iframe tearsheet viewer with reload + open-in-browser), `FilesView.tsx` (artifact list by kind with CodeBlock preview), `PipelineView.tsx` (vertical step-history timeline grouped by run id), and `SubagentList.tsx` (worker rows with tier badge, status dot, tokens/min).
- Rewrote `ArtifactPane.tsx` into a tabbed layout (Tearsheet / Files / Pipeline) with the sub-agent monitor pinned at the bottom across all tabs.
- Added a Markdown renderer (`src/components/Markdown.tsx`) using `marked` + `DOMPurify`: headings, lists, tables, inline code, links (forced `target=_blank` + `rel=noopener`), with images stripped and a sanitized allowlist.
- Added `Message.tsx` (user right-aligned subtle bubble vs assistant markdown), `StreamingCursor.tsx` (pulsing block while a `chat_delta` stream is open), `Thinking.tsx` (collapsible reasoning accordion with elapsed-time label and auto-collapse on done), `StepChip.tsx` (inline pipeline chip with status icon/color + detail tooltip), and `Composer.tsx` (auto-growing textarea, Enter=send / Shift+Enter=newline, send + stop/interrupt while busy).
- Rewrote `ChatPane.tsx` onto the new components: a bottom-anchored message list with auto-scroll and user-scroll override, an inline live turn rail (thinking accordions + step chips) that persists as a transcript after the turn, and the new composer.
- Added `.md-body` markdown styling tokens to `src/index.css` (tables, headings, code, blockquotes, links) consistent with the dark-terminal theme.
- Added `marked` and `dompurify` as `web-ui` runtime dependencies (pre-approved by the wiring spec).
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
