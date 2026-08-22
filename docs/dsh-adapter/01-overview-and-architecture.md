# 01 — Overview and architecture

## What this project is

`prime-quant` is a Windows-first quant research agent: Prime Agent
(`packages/coding-agent`) plus the `primequant` Python engine plus a local
Vite GUI (`packages/web-ui` + `packages/web-ui-server`).

DeepSeek Harness (`dsh`) is a separate MIT agent harness (developer preview,
compatibility-breaking). Its Web UI is **not a skin**. It is the client half of
a Cordis plugin tree: the browser renders a DSH `SessionEvent` log produced by
DSH's own host (`dsh-web-app`). It does not speak our GUI v2 WebSocket contract
and it does not speak `prime-agent.daemon`.

## Product decision (already made — do not relitigate)

1. DSH is an **optional** web surface. Default `prime-agent gui` stays the Vite
   OS shell (Dashboard, Rooms, Trading Bots, Training, Tasks, QuantCards).
2. Prime Agent stays the quant brain: same prompts, tools, IPython kernel,
   `rlm.quant.*`, AST linter, CPCV/DSR/PBO gate, TUI, daemon.
3. We do **not** port quant skills into DSH tools (that replaces the brain).
4. We do **not** point the DSH browser at our daemon or v2 `/ws`.
5. We do **not** iframe DSH inside our shell (two composers, two interrupts).

The three patterns the owner asked for are **layers of one adapter**:

| Pattern | Layer | Seam |
|---|---|---|
| 1. Harness plugin | Packaging | Cordis profile bundle `packages/dsh-prime` installed into `dsh --profile web` |
| 2. Subagent tool | Capability the DSH model sees | `ctx.subagents` provider `prime` + `dsh-tool-subagent` row `subagent_prime` (same seam as Claude Code / Codex / ACP) |
| 3. Daemon API | Transport, later | Host-side `DaemonClient` **inside the plugin**. Not the DSH frontend. Fallback to RPC. Not part of DSH startup |

```
Browser  →  DSH web client (unchanged)
                │  SessionEvent / ConversationController
                ▼
         DSH host (web profile)
                │  Pattern 1: @prime-quant/dsh-prime
                │    ├─ Pattern 2: ctx.subagents `prime` → subagent_prime
                │    └─ Pattern 3 (later): DaemonClient attach, else RPC
                ▼
         Prime Agent  (--mode acp | --mode rpc | daemon attach)
                │  unchanged loop / kernel / skills
                ▼
         MT5 / CSV / tearsheets / cards
```

## Current facts (trust these; verify in your checkout if a date is stale)

| Fact | Detail |
|---|---|
| Native GUI | React + Vite in `packages/web-ui`; v2 contract in `docs/gui-wiring/02-api-contract.md` |
| Bridge | `packages/web-ui-server`: `RpcSession` over `cli.js --mode rpc`, `EventTranslator` RPC→v2, MT5 probe, tearsheet watcher |
| RPC | JSONL stdin/stdout. Framing: split on `\n` only. Docs: `packages/coding-agent/docs/rpc.md` |
| ACP | `prime-agent --mode acp` already exists. Docs: `packages/coding-agent/docs/acp.md`. Extra facts in `_meta.ai.primeintellect.prime-agent` |
| Daemon | `prime-agent.daemon` v7, schema 16. Client: `packages/coding-agent/src/modes/daemon/daemon-client.ts`. GUI wiring deferred daemon attach |
| Bundle path | `packages/coding-agent/dist/bundle/cli.js` — Windows user path. Never `tsx` for the DSH child |
| DSH web | `npx @deepseek-ai/dsh web` → `127.0.0.1:3080`. Bundle `dsh-web-app` over `dsh-base` |
| DSH ACP provider | `@deepseek-ai/dsh-subagent-acp`: spawn `command`/`args`, cwd = parent workspace, **final `agent_message_chunk` text only**, fresh process per run, `inheritsParentContext: false` |
| DSH UI extension | `ConversationNodeDefinition` + `ctx.slots.inject('conversation.chat.node', …)` |
| RAM | `PLAN.md`: GUI is a thin view; 8 GB; do not spawn kernels at GUI/DSH boot |
| Windows | Primary target. `windowsHide: true`. Never `npx` as spawn argv |

## Why a naive swap fails

DSH UI renders only DSH session events. Our GUI consumes v2 `{ chat, card, step, tearsheet, rooms, mt5 }`. There is no adapter until Agent A emits DSH events and Agent B registers nodes for the Prime-specific families.

Stock `dsh-subagent-acp` proves delegation (Phase 1) but **drops** tool traffic and `_meta`, and cold-starts a kernel per run. That is a spike, not the product path.

## Phases (cross-agent)

| Phase | What ships | Who |
|---|---|---|
| 0 | Windows `dsh web` spike, pin, RSS | C |
| 1 | Plugin skeleton + stock ACP `subagent_prime` | A (host) + C (install README) |
| 2 | Pooled `RpcSession` provider + SessionEvent map + ConversationNodes | A (provider/mapper) + B (nodes) |
| 3 | `prime-agent gui --surface dsh` opt-in | C |
| 4 | Daemon attach, capability-gated, RPC fallback | C, blocked on A Phase 2 |
| 5 | Integration checklist on Windows | All, `06` |

Idle DSH must spawn **zero** Prime processes and **zero** kernels.

## Hard constraints

1. **Zero intelligence compromise.** Do not change coding-agent prompts, tools, or kernel to fit DSH.
2. **Native GUI remains default.** `--surface dsh` is opt-in. Uninstalling the plugin must not break `npm run gui:live`.
3. **127.0.0.1 only.** Any HTTP the plugin adds binds IPv4 loopback. DSH already rejects `--host 0.0.0.0`.
4. **Dormant until first `subagent_prime` call.** Matches Claude Code install (provider registered, process not started).
5. **Pin DSH.** Developer preview. Record the exact `@deepseek-ai/dsh*` versions in `packages/dsh-prime/package.json`. Honor 7-day min-release-age.
6. **No second RPC client.** A reuses `packages/web-ui-server` `RpcSession` + `EventTranslator`. Extract only if the package export cannot be imported from the plugin.
7. **Root tsgo is DOM-less.** Host code lives in `packages/dsh-prime/src/**` (included). Client code lives in `packages/dsh-prime/client/**` (not in root `include`). B typechecks the client with its own tsconfig.
8. **Tests:** targeted vitest from `packages/dsh-prime/`. Fake children only. No live provider APIs.

## Non-goals (v1)

- Replacing TUI or daemon
- Multi-session DSH↔Prime session store merge
- Community `dsh-web-ui` task board / skins
- Publishing to the public `dsh-plugin` topic
- Rooms/watchers inside DSH (they stay on `prime-agent schedule` + native GUI)
- Making DSH required for CI
