# 02 — Frozen contract

This is the single source of truth for the adapter seams. All three agents
implement against this file. **Changing it requires an issue titled
`dsh-contract: <topic>` and a written agree-comment from A, B, and C before
anyone edits this document.**

## 1. Package identity

| Field | Value |
|---|---|
| npm name | `@prime-quant/dsh-prime` |
| path | `packages/dsh-prime` |
| DSH profile | `web` only |
| Provider registry name | `prime` |
| Model-facing tool name | `subagent_prime` |
| Patch row ids | listed in §3; never reuse an id for a different package |

Install (user-facing text is C's README; this is the mechanical truth):

```
dsh plugin --profile web add <absolute-or-file-url-of-packages/dsh-prime>
dsh web
```

The plugin must be loadable from a source checkout without publishing to npm.

## 2. Process and spawn (Windows)

Prime child argv is **always**:

```
[process.execPath, <absolute>/packages/coding-agent/dist/bundle/cli.js, "--mode", <acp|rpc>]
```

Rules:

- `windowsHide: true` on every `spawn` / `execFile`.
- No shell. Never `"npx"`, never `"prime-agent.cmd"`.
- cwd of the child = DSH parent session workspace (absolute directory).
- `stdio`: stdin/stdout are the protocol (ACP or RPC JSONL). stderr inherit or pipe-to-log; never write protocol bytes to stderr.
- JSONL (RPC): split on `\n` only. Node `readline` is forbidden.
- Session isolation: `--session-dir` under `packages/dsh-prime/.dsh-sessions` so DSH-spawned RPC sessions do not collide with TUI/GUI sessions.
- Env: do not copy DSH credentials into the child. Prime login remains `~/.prime/agent` (or the product config dir after rebrand). Explicit overlay may pass `PATH` and non-secret locale vars only, unless `02` is amended.
- Do not start the child from `apply()`. Start on first `SubagentProvider.start()` (Phase 2 pool) or on each ACP `start()` (Phase 1).

Phase 1 (stock ACP, config only) uses `--mode acp`.
Phase 2 (product) uses `--mode rpc` via `RpcSession`.
Phase 4 (C) may attach a daemon instead of spawning; spawn remains the fallback.

## 3. `cordis.patch.yml` rows (frozen ids)

Agent A owns the file. B and C do not edit it. If B needs a new client row, open `dsh-contract:` and A inserts the agreed block.

```yaml
# HOST — Agent A
- id: subagent-prime-acp          # Phase 1 only; A disables this row when Phase 2 ships
  name: '@deepseek-ai/dsh-subagent-acp'
  disabled: true                  # C's spike may enable locally; committed default is disabled
  config:
    providerName: prime
    command: <filled at apply-time; see §2>
    args: ['<cli.js>', '--mode', 'acp']
    permission: reject

- id: subagent-prime-rpc          # Phase 2 — A's provider package
  name: '@prime-quant/dsh-prime/host'
  config:
    providerName: prime
    pool: true

- id: tool-subagent-prime
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true                  # match Claude Code: copy a preset / enable to expose
  config:
    provider: prime
    toolName: subagent_prime
    backgroundMode: one-shot
    maxDepth: provider-managed

- id: prime-host-glue             # settings routes, prompt section, mt5 probe cache
  name: '@prime-quant/dsh-prime/host-glue'

# CLIENT — Agent B (A copies these verbatim from this contract)
- id: prime-client-nodes
  name: '@prime-quant/dsh-prime/client'

- id: prime-client-settings
  name: '@prime-quant/dsh-prime/client-settings'
```

`<filled at apply-time>`: A's glue resolves `cli.js` from the monorepo (walk up from cwd looking for `packages/coding-agent/dist/bundle/cli.js`, same idea as `findPreviewBridge`). If missing, the provider stays registered and `start()` fails with a safe error string; DSH still boots.

Exact DSH package names (`@deepseek-ai/dsh-subagent-acp`, tool package id) must be verified against the **pinned** DSH version during A's M0. If upstream renamed a package, A files `dsh-contract:` with the real names; do not guess.

## 4. Subagent provider contract (Phase 2)

A implements the same named-provider interface DSH documents for
`dsh-subagent-claude-code` / `dsh-subagent-acp`. **Read the pinned DSH type
definitions in node_modules after install; do not invent a parallel interface.**

Required behavior, regardless of upstream field names:

| Behavior | Rule |
|---|---|
| `inheritsParentContext` | `false` |
| Input | Concatenated text blocks from the request. No parent transcript |
| cwd | Parent session workspace |
| Success | Final assistant text (and, Phase 2, SessionEvents already appended) |
| Cancel | Maps to aborted; RPC `abort` / ACP `session/cancel` |
| Dispose | Idempotent; does not kill the **pool** on a single run end (Phase 2). Plugin Fiber dispose kills the pool |
| Boot | First `start()` creates the pool; subsequent `start()` reuse it |
| Concurrent start | Reject a second run while the pooled session is busy (Prime ACP/RPC is one turn per process). Caller sees a safe error |
| Capabilities advertised | none (same as stock ACP provider) |

Phase 1 does not implement this interface — it mounts stock ACP.

## 5. SessionEvent families (Phase 2 — A produces, B consumes)

Native DSH events A **must** emit while a Prime run is live (map from RPC via
existing v2 translator, then lift):

| Prime/v2 | DSH (use DSH's real type names from pinned docs) |
|---|---|
| user `chat` | user message event DSH already uses for parent tool args — do **not** duplicate the parent user turn |
| `chat_delta` / `chat` assistant | `assistant/chunk` then `assistant/message` (or the pinned equivalents) |
| `thinking` | whatever DSH uses for reasoning chunks |
| RPC tool start/end | `tool/call` / `tool/result` |

Prime-specific family — **these names are ours**. A appends them to the DSH
session log. B's `ConversationNodeDefinition.match` keys off `event.type`.

### 5.1 `prime/card`

```json
{
  "type": "prime/card",
  "data": {
    "cardId": "c1",
    "title": "Backtest · EURUSD M5",
    "payload": { "status": "success", "metrics": {}, "validation_gate": { "passed": true } }
  }
}
```

`payload` is the existing GUI v2 card payload (`docs/gui-wiring/02` §1.10). B
renders a metric grid + PASS/FAIL. Never dump raw JSON as the primary view.

### 5.2 `prime/step`

```json
{
  "type": "prime/step",
  "data": {
    "stepId": "run-42-backtest",
    "name": "ast_check" | "backtest" | "cpcv_gate" | "optimize" | "tearsheet" | "fetch_data" | string,
    "status": "running" | "done" | "error",
    "detail": "optional"
  }
}
```

Upsert by `stepId`. Unknown `name` is title-cased.

### 5.3 `prime/tearsheet`

```json
{
  "type": "prime/tearsheet",
  "data": {
    "url": "/prime-reports/tearsheet_EURUSD_M5.html",
    "name": "tearsheet_EURUSD_M5.html",
    "ts": "ISO-8601"
  }
}
```

`url` is served by A's host-glue on the DSH webserver, **path-traversal safe**,
same rules as `resolveArtifactPath` in `packages/web-ui-server/src/gui-bridge.ts`.
Bind 127.0.0.1 only (DSH host already is). Route prefix: `/prime-reports/`.

### 5.4 `prime/subagent`

```json
{
  "type": "prime/subagent",
  "data": {
    "id": "sub-1",
    "name": "worker://…",
    "tier": "worker",
    "status": "RUNNING" | "DONE" | "ERROR",
    "task": "optional"
  }
}
```

### 5.5 `prime/mt5` (settings / status, not every chat node)

```json
{
  "type": "prime/mt5",
  "data": {
    "status": "ok" | "down" | "unknown",
    "detail": { "server": "…", "login": 0, "symbols": 0 },
    "checkedAt": "ISO-8601"
  }
}
```

Emitted at most once per 30 s (reuse `createMt5Probe` cache). B's settings card
reads this; chat may ignore it.

### 5.6 Out of v1 SessionEvent log

- Full `.py` / `.mq5` file bodies (too large). Serve via `/prime-reports/` or
  omit; native GUI remains the artifact library.
- `rooms_*` / watcher schedule. Native GUI + `prime-agent schedule` only.

If DSH requires extending `SessionEventMap` via declaration merging, A owns
that merge in `src/`; B imports the type from a **type-only** file A exports
(`src/prime-events.ts`). B does not duplicate the payload shapes.

## 6. Mapper pipeline (A)

```
RPC JSONL record
  → existing EventTranslator (v2 events)   // reuse, do not fork mapping rules
  → PrimeSessionBridge
       v2 chat_delta/chat/thinking/step/card/tearsheet/subagent
         → DSH native + prime/* SessionEvents
```

Card sniffing stays in the existing `sniffCard` / `CardSniffer` path. Do not
invent a second card detector.

## 7. Client slots (B)

| Slot / API | Key | Renderer |
|---|---|---|
| `conversation.chat.node` | `prime-card` | Quant card |
| `conversation.chat.node` | `prime-step` | Pipeline chip / step row |
| `conversation.chat.node` | `prime-tearsheet` | Sandboxed iframe + open-in-browser |
| `conversation.chat.node` | `prime-subagent` | Status row |
| settings plugins tab | `prime-agent` | Path-to-cli (read-only resolved), MT5 pill, kernel hint, enable-tool copy |

Node `kind` strings: `prime-card`, `prime-step`, `prime-tearsheet`, `prime-subagent`.
Match functions key on `event.type` in §5.

B may reuse visual language from `packages/web-ui/src/components/QuantCard.tsx`,
`StepChip.tsx`, `TearsheetView.tsx` by **copying the rendering ideas**, not by
importing the Vite app (DOM/React versions and bundling differ). Do not add
those web-ui files to B's ownership.

## 8. Launch flag (C)

```
prime-agent gui                 → existing Vite + preview-bridge (unchanged)
prime-agent gui --surface dsh   → spawn dsh web for this checkout's plugin
```

- Default remains Vite.
- `--surface dsh` fails fast with an actionable message if `dsh` is not
  installed or `packages/dsh-prime` is missing.
- Spawn `dsh` the same Windows-safe way as `launchGui` today (`process.execPath`,
  `windowsHide`, 127.0.0.1). Do not `npx` if a local `node_modules/.bin` path
  exists; if C must use npx, wrap via `process.execPath` + `npx/bin/npx-cli.js`,
  never `npx.cmd`.
- Browser open: existing `--open` behavior. SSH/no-open: follow DSH's own
  `--no-open` if spawning `dsh web`.

Pattern 3 (C, later): if a daemon socket exists, A's provider (or C's transport
module called by A) attaches with `DaemonClient`. **New daemon commands are
forbidden in v1.** Use existing attach/prompt. Negotiate capabilities; if attach
fails, RPC spawn. DSH `apply()` must not require a daemon.

## 9. Tests vs live DSH

| Who | Allowed in CI |
|---|---|
| A | vitest with fake RPC child; mapper unit tests v2→prime/* |
| B | vitest/node tests on match/fold functions; no browser DSH host required. If a React renderer test needs jsdom, keep it inside `packages/dsh-prime/client` and **exclude it from root tsgo** |
| C | Launch-path unit tests (find plugin, refuse bundle-only install). No live `dsh web` in CI unless vendored and already in-tree — default: document the Windows spike, do not gate CI on DSH |

## 10. Changelog

One Unreleased bullet per user-visible change, past tense, one line
(`packages/*/CHANGELOG.md`). A: optional DSH plugin host. B: none until nodes
are user-visible (then coding-agent or a new dsh-prime changelog if the package
has one). C: `--surface dsh`, install docs.

Do not edit released version sections.
