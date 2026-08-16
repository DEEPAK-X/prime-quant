# 01 — Overview and Architecture

## What this project is

`prime-quant` is a fork of the prime-agent monorepo turned into a quant
research agent:

- `packages/coding-agent` — the agent itself (TUI + daemon + RPC mode). Runs on
  Windows; its IPython kernel (`rlm.quant` skills) pulls live market data from
  a local MetaTrader 5 terminal and runs backtests/validation/tearsheets.
- `prime-quant/` — the deterministic Python engine (`primequant` package).
- `packages/web-ui` — a React + Vite GUI ("quant research terminal"). Currently
  renders against a **fake** backend (`server/demo-backend.mjs`) that emits
  scripted events.

## Goal of this work

Replace the demo backend with a **real bridge** so the GUI drives an actual
agent session end-to-end, and redesign the frontend so it looks and feels like
a modern AI harness (the reference look: the ZCode harness — left session
sidebar, centered streaming chat with markdown/code blocks and collapsible
reasoning, right-hand artifact panel). The demo backend stays as an offline
fallback.

## Non-goals (v1)

- No multi-session management UI (one live session; session list is v2)
- No authentication/HTTPS — bridge binds to `127.0.0.1` only
- No order placement / trading of any kind (read-only market data)
- No daemon coordination (attach/detach) — one dedicated RPC child process
- No mobile layout

## Current state (verified facts — trust these)

| Fact | Detail |
|---|---|
| GUI stack | React 18 + Vite + Tailwind, entry `packages/web-ui/src/main.tsx` |
| GUI↔backend contract | Defined in `packages/web-ui/src/lib/ws.ts` (events: `chat`, `step`, `subagent`, `tearsheet`, `artifact`) |
| Demo backend | `packages/web-ui/server/demo-backend.mjs` — HTTP + `ws` WebSocket on port 3001, endpoints `/api/*`, `/ws` |
| Preview runner | `packages/web-ui/server/preview.mjs` — starts Vite (5173) then demo backend (3001); Vite proxies to 3001 |
| Bridge package (started) | `packages/web-ui-server` (remote commit `c8a080bb`, "Phase 8A"): TS package `@earendil-works/pi-web-ui-server` with `src/gui-bridge.ts` — HTTP+WS server, `BridgeSession` interface (`prompt`/`subscribe`/`getLastAssistantText`), path-traversal-safe artifact serving, `SUBAGENT_*`/`PIPELINE_STEP_UPDATE`/`ARTIFACT_READY` events, vitest tests. **No RPC subprocess, no GUI v2 contract, no MT5 probe yet — that's this phase's work** |
| Agent headless mode | `packages/coding-agent` RPC mode: JSONL over stdin/stdout. Full protocol doc: `packages/coding-agent/docs/rpc.md` |
| Reference RPC client | `packages/coding-agent/src/modes/rpc/rpc-client.ts` (TypeScript, subprocess-based) |
| Agent start command | `npx tsx packages/coding-agent/src/cli.ts --mode rpc` (repo root as cwd) |
| LLM auth | The agent needs a provider login (`/login` in TUI creates the config). Without it the RPC session errors on first prompt |
| MT5 | Terminal installed at `C:\Program Files\MetaTrader 5`, auto-login to XMGlobal. Kernel venv python at `%USERPROFILE%\.prime\agent\kernel-venv\Scripts\python.exe` |
| Tearsheets | `rlm.quant.run_pipeline(...)` writes HTML reports (e.g. `tearsheet_EURUSD_M5.html`) into the agent process **cwd** (repo root by default) |

## Target architecture

```
┌────────────┐  HTTP/WS (127.0.0.1:3001)  ┌──────────────────────┐  stdin JSONL  ┌─────────────────┐
│  Browser    │◄──────────────────────────►│  gui-bridge (Node)   │◄─────────────►│ prime-agent     │
│  Vite GUI   │                            │  packages/web-ui/    │  stdout JSONL │ --mode rpc      │
│  :5173      │                            │  server/bridge.mjs   │               │ (npx tsx …)     │
└────────────┘                            └──────────────────────┘               └────────┬────────┘
                                           │  spawns + restarts                            │
                                           │  watches *.html in cwd (tearsheets)           │ kernel venv
                                           │  polls MT5 health via venv python             ▼
                                           │                                    MetaTrader 5 IPC
                                           ▼                                    (read-only)
                                    serves /reports/*.html
```

Components:

1. **gui-bridge** (Agent A) — continues the existing
   `packages/web-ui-server` TS package. Responsibilities:
   - Implement `BridgeSession` (already defined in `gui-bridge.ts`) over an
     RPC **subprocess** (`npx tsx …/cli.ts --mode rpc`) — the missing piece
   - Own the child process lifecycle (spawn, health, restart with backoff)
   - Translate RPC events → GUI v2 events per `02-api-contract.md`
   - Serve REST snapshots and tearsheet files (reuse the existing
     traversal-safe `resolveArtifactPath`)
   - MT5 connection status probe (cached, read-only)
2. **GUI** (Agent B) — redesigned React app consuming the same contract.

## Hard constraints

1. **Run the local source, not the npm package.** The published
   `@earendil-works/pi-coding-agent` does NOT contain this fork's Windows
   kernel fixes. The bridge MUST spawn the agent via
   `npx tsx packages/coding-agent/src/cli.ts --mode rpc` from the repo root.
2. **JSONL framing:** split RPC stdout on `\n` only. Node `readline` is
   non-compliant (it splits on U+2028/U+2029, valid inside JSON strings).
   Hand-buffer chunks. See `rpc-client.ts` for a compliant reader.
3. **Windows is the target OS.** Spawn `npx` via `process.execPath` +
   the tsx CLI JS path (pattern already used in `server/preview.mjs`) — never
   spawn `"npx"` directly on win32 (it's a `.cmd` shim; `spawn` without
   `shell: true` fails).
4. **Bridge binds `127.0.0.1` only.** It can read files and spawn processes;
   it must never listen on `0.0.0.0`.
5. **Do not break the demo fallback.** The GUI must still run against
   `demo-backend.mjs` (an env flag / auto-probe switches between them).
6. **Token budget cards.** Quant skill responses are compact JSON cards
   (<150 tokens) — render them as formatted cards, never as raw walls of text.

## Tech decisions (already made — do not relitigate)

- Bridge home: **continue `packages/web-ui-server`** (TypeScript, added in
  Phase 8A). Run it with `npx tsx packages/web-ui-server/src/main.ts` (tsx is a
  root devDependency). Tests use vitest, single-file invocations only (repo
  rule): from `packages/web-ui-server/` run
  `npx tsx ../../node_modules/vitest/dist/cli.js --run test/gui-bridge.test.ts`
- WebSocket lib: `ws` (already a web-ui-server dependency; `@types/ws` installed)
- Frontend: keep **React + Vite + Tailwind**, rebuild the UI layer. Do NOT
  clone Vercel ai-chatbot / open-webui / LobeChat: they are general-purpose
  chat apps; adapting them to the split-pane quant terminal + pipeline strip +
  tearsheet artifacts costs more than polishing our own 700-line app. Borrow
  design cues (message bubbles, streaming cursor, code block chrome) instead.
- No state library; existing hook-based store pattern (`useQuantSocket`)
  extends to the v2 contract.
