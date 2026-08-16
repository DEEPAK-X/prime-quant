# 03 — Agent A: Backend Bridge

You own `packages/web-ui-server/**`, `packages/web-ui/server/**`, and the
root `package.json` script entries. Do not touch `packages/web-ui/src/**`
(Agent B's) or `packages/coding-agent/src/**` (out of scope for this phase).

Deliverable: extend `packages/web-ui-server` into the real bridge — RPC
subprocess behind the existing `BridgeSession` interface, GUI v2 contract,
tearsheet watching, MT5 probe — implementing `02-api-contract.md` server-side.

Reference reading before coding (in this order):

1. `docs/gui-wiring/02-api-contract.md` — the interface you implement
2. `packages/web-ui-server/src/gui-bridge.ts` — **your starting point**:
   `BridgeSession` interface, HTTP/WS scaffolding, `resolveArtifactPath`
3. `packages/web-ui-server/test/gui-bridge.test.ts` — existing tests must
   keep passing; extend, don't break
4. `packages/coding-agent/docs/rpc.md` — the agent's JSONL protocol
5. `packages/coding-agent/src/modes/rpc/rpc-client.ts` — compliant reader/writer
6. `packages/web-ui/server/demo-backend.mjs` — v1 event shapes for parity
7. `packages/web-ui/server/preview.mjs` — Windows-safe spawn pattern
8. `AGENTS.md` — repo rules

## Architecture

```
packages/web-ui-server/src/
├── index.ts          (exists) exports
├── gui-bridge.ts     (exists) HTTP/WS server + BridgeSession interface — extend
├── rpc-session.ts    NEW: BridgeSession impl over the RPC subprocess
├── rpc-client.ts     NEW: JSONL child-process client (spawn, \n-split reader, writer)
├── translator.ts     NEW: RPC events → v2 contract events (mapping below)
├── mt5.ts            NEW: throttled venv-python probe
├── tearsheets.ts     NEW: cwd watcher + report registry
└── main.ts           NEW: composition root (wires everything, runs the server)
```

## Milestone M0 — Baseline

- [ ] `npm install` (fresh cloud machine) then, from `packages/web-ui-server/`:
      `npx tsx ../../node_modules/vitest/dist/cli.js --run test/gui-bridge.test.ts`
      → all existing tests pass
- [ ] Read `gui-bridge.ts` fully; note `BridgeSession` is your extension point

## Milestone M1 — RPC subprocess client (`rpc-client.ts`, `rpc-session.ts`)

- Spawn from repo root (resolve as
  `path.resolve(packageDir, "..", "..")`).
- Windows-safe spawn (pattern from `preview.mjs`): use `process.execPath` +
  the tsx CLI entry resolved via `createRequire(import.meta.url).resolve("tsx/package.json")`
  (verify the dist entry filename in your checkout, `tsx/dist/cli.mjs` is the
  documented bin). Never spawn `"npx"` directly on win32 (`.cmd` shim).
- Argv: `packages/coding-agent/src/cli.ts --mode rpc --cwd <repoRoot>`.
  Do NOT pass `--no-session` (we want persistence). Consider
  `--session-dir packages/web-ui-server/.gui-sessions` to isolate GUI sessions
  from TUI sessions.
- JSONL reader: hand-buffer string chunks, split on `\n` only, strip one
  trailing `\r`, `JSON.parse` each record, log-and-continue on parse failure.
  **Node `readline` is forbidden** (splits on U+2028/U+2029 inside JSON
  strings — rpc.md §Framing).
- Writer: `child.stdin.write(JSON.stringify(cmd) + "\n")`.
- `RpcSession implements BridgeSession`:
  - `prompt(message)`: if a turn is streaming, resend with
    `"streamingBehavior": "followUp"` (rpc.md §Prompting)
  - `subscribe(listener)`: fan out every translated event
  - `getLastAssistantText()`: buffer from `message_end` events
- Sequence on start: wait for the first RPC response/`agent_start` before
  exposing `agent_state: ready`; emit `starting` before that.

**Acceptance:**

- [ ] `npx tsx packages/web-ui-server/src/main.ts` starts, spawns the agent,
      logs `[bridge] agent ready` within 60 s (kernel venv already cached)
- [ ] New test file `test/rpc-session.test.ts` drives a **fake** RPC child
      (injected `spawn` returning an EventEmitter duplex double — no real
      agent in CI): prompt → response correlation, followUp while busy,
      restart-on-exit with capped backoff (1 s → 30 s, max 5 attempts)
- [ ] Real-process smoke (documented in PR, run on the Windows box):
      `{"type":"prompt","message":"ping"}` yields
      `{"type":"response","command":"prompt","success":true}`

## Milestone M2 — Event translation (`translator.ts`)

Map RPC events (`rpc.md` §Events) to contract events:

| RPC event | Contract event(s) |
|---|---|
| `message_start` (role assistant) | open a pending message buffer keyed by message id |
| `message_update` (text deltas) | `chat_delta { id, delta }` |
| `message_update` (thinking deltas) | `thinking { id, delta, done:false }` |
| `message_end` (assistant text) | `chat { role:"assistant", text, id, ts }` |
| `agent_start` | `agent_state { state:"busy" }` |
| `agent_end` | `agent_state { state:"ready" }` |
| `tool_execution_start` (ipython cell) | `step { name:<derived>, status:"running" }` — derive the stage from cell text: `fetch_data`→`fetch_data`, `run_backtest`→`backtest`, `run_pipeline`/`validate`→`cpcv_gate`, `optimize`→`optimize`; fallback `backtest` |
| `tool_execution_end` | matching `step { status:"done"\|"error", detail:<first 80 chars of result> }` |
| `tool_execution_update` | ignore (v1) |
| our own `prompt` echo | `chat { role:"user", text }` |
| `compaction_start/end` | `step { name:"compaction", … }` |
| any `response` with `success:false` | `error { scope:"agent" }` |
| session `rlm_child_update` (via existing `mapSessionEvent`) | v2 `subagent` event (translate `SUBAGENT_SPAWNED`→`status:"RUNNING"`, `SUBAGENT_COMPLETED`+done→`"DONE"`/error→`"ERROR"`) |

Rules:

- One `step` `id` per tool execution instance: `run-<n>-<stage>`, monotonic n.
- Assistant text is markdown — pass through unchanged, no escaping.
- Unit-test the translator with recorded RPC event fixtures
  (`test/translator.test.ts`); no real agent needed.

**Acceptance:**

- [ ] Prompt "hello" through the WS renders one streamed assistant message
      ending in a final `chat` with identical text
- [ ] Translator tests cover every row of the mapping table

## Milestone M3 — Card sniffing + artifacts + tearsheets (`tearsheets.ts`)

The quant skills return compact JSON cards as assistant text or inside tool
output. Sniff: if the complete assistant message (trimmed) parses as JSON and
has any of the keys `status`, `metrics`, `validation_gate`, `report`, `qa`,
`optimization`, emit `card { title, payload }` immediately after the `chat`.
Title: `spec.symbol` + timeframe when present, else "Result".

Tearsheets/artifacts:

- Watch repo root with `fs.watch` (recursive works on Windows): debounce
  500 ms, filter `*.html`; plus register any path seen in
  `card.payload.report.report_path`.
- Maintain the registry (name, url `/reports/<name>`, mtime as ts); on new or
  updated entries broadcast `tearsheet`.
- `GET /reports/<file>` implemented on top of the existing
  `resolveArtifactPath` allowlist (root = repo root); reject names containing
  `..`, `/`, `\` after decoding.
- Artifacts (`*.py`, `*.mq5`, `*.md` created by tool runs, detected by
  before/after directory diff around `tool_execution_end`): read (cap 256 KB),
  emit `artifact`.

**Acceptance:**

- [ ] A `run_pipeline` prompt produces: steps (lint→backtest→gate→tearsheet),
      a `card` with metrics + validation_gate, and a `tearsheet` event whose
      `/reports/…` URL returns the HTML
- [ ] `test/tearsheets.test.ts` covers registry + traversal rejection

## Milestone M4 — MT5 probe (`mt5.ts`)

```js
const PY = path.join(os.homedir(), ".prime", "agent", "kernel-venv",
  process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
```

Probe script (via `-c`): import MT5Bridge, `initialize()`, on success collect
`account_info().server`, `.login`, `symbols_get()` count, `shutdown()`, print
one JSON line; on failure `{"status":"down","reason":…}`. Timeout 10 s
(`AbortController` + child kill). **Read-only; never send orders.** Missing
venv → `status:"unknown"` with reason. Cache 30 s, single in-flight, dedupe.
Expose via `GET /api/mt5` and include in `hello` / on `refresh_mt5`.

**Acceptance:**

- [ ] Terminal running → `ok` + server/login/symbols
- [ ] Terminal closed → `down` within 10 s; a second call within 30 s hits
      cache only (log proves no python spawn)

## Milestone M5 — v2 HTTP/WS surface + composition (`gui-bridge.ts`, `main.ts`)

- Implement every route + WS behavior of `02` §1–§3 on the existing server:
  `hello` first-frame, `agent_state`, `chat`/`chat_delta`/`thinking`/`step`/
  `subagent`/`tearsheet`/`artifact`/`card`/`error` broadcasts, client
  `chat`/`interrupt`/`refresh_mt5`, REST snapshots backed by an in-memory
  state store fed by the same events (single source of truth).
- Bind `127.0.0.1` explicitly.
- Keep legacy `/api/chat` + `/ws/events` working until the integration phase
  cleanup (their tests must stay green).
- `main.ts`: composition root — RpcSession + translator + tearsheets + mt5 +
  bridge; graceful SIGINT/SIGTERM shutdown (kill child tree).
- Root `package.json` (you own it this phase): add
  `"server": "npx tsx packages/web-ui-server/src/main.ts"` (replace the
  preview.mjs one), `"server:demo": "node packages/web-ui/server/demo-backend.mjs"`,
  `"gui:live": "node packages/web-ui/server/preview-bridge.mjs"`.
- `packages/web-ui/server/preview-bridge.mjs`: copy of `preview.mjs` with the
  backend swapped to the bridge entry (spawn via `process.execPath`, tsx
  resolved the same way preview.mjs resolves vite).

**Acceptance (all must pass):**

- [ ] `npm run server` → bridge alone on 3001; `curl 127.0.0.1:3001/api/health`
      returns `{ ok, backend:"bridge", agentState }`
- [ ] `npm run gui:live` → GUI on 5173 talking to the bridge
- [ ] Full e2e: send chat → streamed reply → quant prompt yields card +
      tearsheet URL rendering in the browser
- [ ] All web-ui-server tests pass (per-file vitest invocations)
- [ ] `npm run check` passes

## Out of scope for you

- Anything in `packages/web-ui/src/**`
- Daemon attach/detach coordination
- Auth, HTTPS, remote bindings
