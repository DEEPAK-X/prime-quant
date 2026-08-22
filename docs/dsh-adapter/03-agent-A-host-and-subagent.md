# 03 — Agent A: Host plugin and Prime subagent provider

You own `packages/dsh-prime/package.json`, `packages/dsh-prime/cordis.patch.yml`,
`packages/dsh-prime/src/**`, and `packages/dsh-prime/test/**`.

Do not touch `packages/dsh-prime/client/**` (B), `packages/dsh-prime/README.md` (C),
`packages/coding-agent/src/cli/gui-launch.ts` (C), daemon protocol files (C),
or `packages/web-ui/src/**`.

You may **import** `RpcSession`, `EventTranslator`, `createMt5Probe`,
`resolveArtifactPath`, `sniffCard` from `@earendil-works/pi-web-ui-server`
(`packages/web-ui-server`). You may not rewrite the Vite bridge. If the import
cannot work (package exports, DOM-less constraints), extract a tiny shared
module **in a new file under web-ui-server** and file `dsh-contract:` so C/B
know; keep the extraction mechanical (move, re-export). Ask before deleting
bridge behavior.

Deliverable: a Cordis host plugin that registers provider `prime` and, in
Phase 2, drives a **pooled** Prime RPC child, translating v2 events into the
SessionEvent families in `02` §5 so B's nodes have something to match.

## Reference reading (this order)

1. `docs/dsh-adapter/01-overview-and-architecture.md`
2. `docs/dsh-adapter/02-frozen-contract.md` — **you implement this, you do not invent extra event types**
3. `packages/web-ui-server/src/rpc-session.ts` — pooled child you will wrap
4. `packages/web-ui-server/src/rpc-client.ts` — JSONL framing
5. `packages/web-ui-server/src/translator.ts` — RPC → v2 (reuse)
6. `packages/web-ui-server/src/gui-bridge.ts` — `resolveArtifactPath`
7. `packages/web-ui-server/src/mt5.ts` — probe cache
8. `packages/coding-agent/docs/rpc.md`
9. `packages/coding-agent/docs/acp.md` — Phase 1 only
10. Pinned DSH: `dsh-subagent` types, `dsh-subagent-acp` README, Conversation
    host "how to append SessionEvents". **Read node_modules after pin; do not
    guess `ctx.subagents.register` signatures.**
11. `AGENTS.md`

## Layout you create

```
packages/dsh-prime/
  package.json
  tsconfig.json                 # Node, matches repo
  cordis.patch.yml              # frozen ids from 02 §3
  src/
    prime-events.ts             # payload types for 02 §5; B type-imports these
    resolve-cli.ts              # walk-up find bundle/cli.js
    host/
      index.ts                  # apply() — register provider, no spawn
      glue.ts                   # prompt section, /prime-reports/, mt5 cache
      acp-patch.ts              # optional helper to fill ACP command path
      provider.ts               # Phase 2 SubagentProvider
      session-bridge.ts         # v2 EventTranslator output → SessionEvents
      pool.ts                   # one RpcSession, lazy start, busy lock
  test/
    resolve-cli.test.ts
    session-bridge.test.ts
    pool.test.ts
    provider.test.ts
```

Client directory is B's. Do not create placeholder React files.

## Architecture

```
apply(ctx)
  resolve cli.js (may be missing → still apply)
  ctx.subagents.register('prime', PrimeRpcProvider)   # Phase 2
  glue: prompt section + static reports route
  # no child process

PrimeRpcProvider.start(request)
  pool.ensure()                    # RpcSession.start() once
  if pool.busy → reject safe error
  pool.prompt(text)
  subscribe translator → session-bridge.append(SessionEvents)
  wait until turn ends or abort
  return final assistant text

PrimeRpcProvider.dispose (per-run)
  abort if running; do not stop pool

plugin Fiber dispose
  pool.stop()
```

Phase 1 is config-only: `cordis.patch.yml` row `subagent-prime-acp` pointing at
stock `@deepseek-ai/dsh-subagent-acp` with `disabled: true` in git. Your glue
still resolves `command` so C can flip `disabled: false` locally for the spike.

## Milestone A0 — Package skeleton (no DSH required)

- [ ] `packages/dsh-prime/package.json`: `name` `@prime-quant/dsh-prime`,
      `private: true`, `"type": "module"`, workspace-compatible.
      Pin DSH peer/optional deps only after checking `.npmrc` 7-day rule.
      If DSH packages cannot be a workspace dep without pulling the world,
      document in the PR that C's install README uses `dsh plugin add` on the
      folder and A only type-imports via a thin `src/dsh-types.ts` with
      **manual** interfaces copied from pinned docs and marked
      `// pinned dsh@<version>` — still no `any`.
- [ ] `cordis.patch.yml` with **all** §3 ids present. Phase 2 host name must
      resolve. ACP and `tool-subagent-prime` rows `disabled: true`.
- [ ] `src/prime-events.ts` exporting the §5 payload types (`PrimeCardEvent`,
      etc.). This file is the type surface B imports.
- [ ] `src/resolve-cli.ts`: walk up from a start directory for
      `packages/coding-agent/dist/bundle/cli.js` (copy the loop shape from
      `findPreviewBridge` in `gui-launch.ts`; do not import gui-launch — C owns
      it). Return `undefined` when missing.
- [ ] Test: fake directory tree (tmpdir) finds and misses the bundle.

**Acceptance:** `npx tsx ../../node_modules/vitest/dist/cli.js --run test/resolve-cli.test.ts`
from `packages/dsh-prime/` passes. `npm run check` green. No spawn.

## Milestone A1 — Session bridge (no child)

Implement `session-bridge.ts`: function
`v2ToPrimeSessionEvents(event: V2Event): PrimeSessionAppend[]`.

Mapping table (implement exactly; unknown v2 types → empty array):

| v2 `type` | Append |
|---|---|
| `chat_delta` | DSH assistant chunk (or a `prime/chunk` **only if** pinned DSH forbids custom chunks — prefer native; if you must custom, file `dsh-contract:` first) |
| `chat` role assistant | DSH assistant message complete |
| `chat` role user | **drop** (parent DSH already has the tool-call user turn) |
| `thinking` | DSH thinking/reasoning native event if it exists; else skip (do not invent) |
| `step` | `prime/step` |
| `card` | `prime/card` |
| `tearsheet` | `prime/tearsheet` (rewrite `url` to `/prime-reports/<basename>` if it was a bridge `/reports/` path) |
| `subagent` | `prime/subagent` |
| `agent_state` / `hello` / `error` / rooms | drop from chat log; glue may log errors |

Use `EventTranslator` + a recorded list of RPC-like records in the test to
prove a card-sniffed assistant message becomes `prime/card`. Reuse `sniffCard`
from web-ui-server.

**Acceptance:**

- [ ] `test/session-bridge.test.ts` covers: delta+final chat, step upsert
      identity (`stepId` stable), card payload round-trip, tearsheet url
      rewrite, user chat dropped, unknown v2 ignored.
- [ ] No filesystem, no spawn.

## Milestone A2 — RpcSession pool (fake child)

`pool.ts` wraps `RpcSession`:

- `ensure()` calls `session.start()` once.
- `prompt(text)` → `session.prompt`; busy flag until translator emits a
  turn-end signal. Derive busy from v2 `agent_state` (`busy`/`ready`) if
  RpcSession exposes it (`getAgentState()`), not from a timer.
- Second `prompt` while busy throws a typed error (string safe for DSH).
- `abort()` → RPC abort/interrupt. Read `RpcSession` for the actual method
  (`interrupt` vs sending `{type:"abort"}` through the client). Add a method
  on a **wrapper**, not by editing RpcSession, unless the class already has
  it. If you must add `abort()` to `RpcSession`, that is a web-ui-server
  change you own for this line only — keep it backward compatible for the
  Vite bridge (empty abort while idle is a no-op).
- `stop()` disposes the child.
- Inject `spawn` in tests (existing `RpcSession` option). Fake child is an
  EventEmitter duplex that answers `get_state` then `prompt`. Copy the fake
  from `packages/web-ui-server/test/` if one exists; do not start a real agent.

Windows: the real `RpcChildClient` must already pass `windowsHide: true`. If
you spawn outside RpcSession, you must pass it too.

**Acceptance:**

- [ ] `test/pool.test.ts`: ensure is idempotent; prompt while busy rejects;
      abort; stop is idempotent; fake get_state → ready.
- [ ] Still no live Prime.

## Milestone A3 — Provider `apply` + `start`/`dispose`

Read pinned DSH `SubagentProvider` types. Implement `src/host/provider.ts`.

- `inheritsParentContext: false`.
- Concatenate request text blocks.
- `start`: `pool.ensure()`, subscribe bridge appends onto whatever
  `ctx.sessions` / session-log API the pinned host gives you. If the provider
  API has no session handle, file `dsh-contract:` — do not print events to
  console as a substitute.
- Return final assistant text from `RpcSession.getLastAssistantText()` (already
  on the class).
- Per-run dispose: abort in-flight prompt; **do not** `pool.stop()`.
- Host `apply` in `src/host/index.ts` registers the provider as `prime`.
  Resolves cli path; if missing, register anyway and fail on `start` with
  `Prime Agent bundle not found (expected packages/coding-agent/dist/bundle/cli.js). Run from a Prime Quant checkout.`

**Acceptance:**

- [ ] `test/provider.test.ts` with fake spawn: start → prompt → completed
      output; start missing-cli → safe error; dispose while running → aborted;
      Fiber-level stop kills pool (call your dispose hook).
- [ ] `apply` does not spawn (assert spawn not called until `start`).

## Milestone A4 — Glue: reports route, MT5, prompt section

`src/host/glue.ts`:

- Register HTTP GET `/prime-reports/*` on DSH `ctx.webServer` **if that
  service exists in the pinned host**. If the API differs, adapt; still use
  `resolveArtifactPath` with artifacts root = Prime child cwd (repo root /
  workspace). 404 on miss. No directory listings.
- MT5: wrap `createMt5Probe`. Cache 30 s. Do not probe at `apply()`. Probe on
  first settings read or first `start()`. Emit `prime/mt5` only if you have a
  session log handle; otherwise expose a glue method B's settings host-call
  can hit. If DSH settings are client-only, add a small JSON route
  `GET /prime-status` `{ mt5, cliPath, pool: "idle"|"busy"|"stopped" }` bound
  on loopback via the host. File `dsh-contract:` if B needs a different shape.
- Prompt section: short, stable. Tell the DSH model that backtests,
  validation gates, MT5, tearsheets, and `rlm.quant.*` must be delegated to
  tool `subagent_prime`, not reimplemented in bash. Do not dump skill files
  into the DSH prompt (token budget).

**Acceptance:**

- [ ] Path traversal tests for `/prime-reports/` (`../`, UNC, absolute).
- [ ] Prompt section is a constant string in source (snapshot-friendly).
- [ ] No probe, no spawn in `apply()`.

## Milestone A5 — Phase 1 ACP row (config)

Fill `subagent-prime-acp` command/args using `resolve-cli` so C can enable the
row for the Windows spike without editing TypeScript. Keep `disabled: true`
in the committed patch.

Document in the PR (not README.md — C owns that) the exact local toggle C
uses.

**Acceptance:** committed tree does not spawn ACP. C's spike instructions in
`05` match your patch ids.

## Milestone A6 — Phase 2 default

- `subagent-prime-rpc` is the active provider row (`disabled` absent/false).
- `subagent-prime-acp` stays disabled in git.
- `tool-subagent-prime` stays `disabled: true` (Claude Code pattern: user or
  C's launch profile enables it). Provide a **comment in the YAML** that C
  may enable it in a user overlay, not in this repo's default if that would
  surprise vanilla DSH coding sessions. Confirm with `02`: committed default
  is disabled; C's `--surface dsh` overlay enables the tool.

If enabling the tool by default is required for `--surface dsh` to work
without a manual settings click, **do not** change `02` yourself — C files
`dsh-contract:` to allow `disabled: false` for `tool-subagent-prime` when the
Prime Quant overlay is applied. A's git copy stays disabled until that lands.

## Hard rules

- No `any`. No inline `import()`.
- `windowsHide: true` on any spawn you add.
- Never `git add -A`.
- Do not run `npm run dev` / `build` / `npm test`.
- Do not start Pattern 3. If you think daemon attach belongs in the pool,
  leave a `Transport` interface with only `rpc` implemented:
  `type Transport = "rpc"` in v1. C will add `"daemon"` later **in a file
  they own or via a PR you review** — prefer C adding `src/host/transport-daemon.ts`
  which you import behind the interface. Coordinate in `dsh-contract:` so
  both don't create the interface twice. **A defines:**

  ```ts
  export interface PrimeTransport {
    ensure(): Promise<void>;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    stop(): Promise<void>;
    subscribe(listener: (event: V2Event) => void): () => void;
    getLastAssistantText(): Promise<string | undefined>;
    getAgentState(): AgentState;
  }
  ```

  Rpc pool implements this. C's daemon transport implements it later.

- Changelog: one Unreleased bullet on `packages/coding-agent/CHANGELOG.md`
  only when a user can install the plugin — likely after A4. Append, don't
  reorder. Example:
  `Added an optional DeepSeek Harness plugin that delegates quant work to Prime Agent over RPC.`

## What “done” means for you (before integration)

A0–A4 merged. Fake-child tests pass. `npm run check` clean. B can import
`prime-events.ts`. C can read `cordis.patch.yml` ids. Live DSH is **not**
your acceptance gate (`06` is).
