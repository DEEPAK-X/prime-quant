# PrimeQuant GUI Wiring — Agent Handoff Pack

This directory contains the complete, self-contained plan for replacing the demo
web GUI backend with a real bridge to the prime-quant coding agent, plus a full
frontend redesign.

**You are one of two independent agents working from separate machines.** All
context needed to do the work is in these files — no conversation history is
required.

## Documents

| File | Audience | Contents |
|---|---|---|
| `01-overview-and-architecture.md` | Both | Current state, target architecture, hard constraints, tech decisions |
| `02-api-contract.md` | Both | **FROZEN** bridge ↔ GUI REST + WebSocket contract. Both agents code against this document, not against each other's code |
| `03-agent-A-backend-bridge.md` | Agent A only | Backend bridge implementation plan, milestones, acceptance tests |
| `04-agent-B-frontend.md` | Agent B only | Frontend redesign plan, design spec, milestones, acceptance tests |
| `05-integration-and-verification.md` | Both | End-to-end integration procedure, verification checklist, git coordination rules |

## Read order

1. Agent A: `01` → `02` → `03` → `05`
2. Agent B: `01` → `02` → `04` → `05`

## File ownership (hard rule)

| Path | Owner |
|---|---|
| `packages/web-ui-server/**` | Agent A |
| `packages/web-ui/server/**` | Agent A |
| `packages/web-ui/src/**` | Agent B |
| `packages/web-ui/vite.config.ts` | Agent B |
| `package.json` (root, scripts only) | Agent A |
| `packages/web-ui/package.json` | The agent that needs the dependency; coordinate via `02` if a dep is shared |
| `docs/gui-wiring/02-api-contract.md` | **Frozen.** Changes require both agents to agree in writing (issue comment) |

## Repo rules that apply to you

Read `AGENTS.md` at the repo root before writing any code. Non-negotiables:

- `npm run check` must pass before every commit (biome + tsgo, zero warnings)
- Never `git add -A`; stage only files you created or modified
- Never `git reset --hard`, `git checkout .`, `git stash`, or force push
- No `any` types, no inline `import()`; standard top-level imports only
- 7-day minimum release age for new npm dependencies (`.npmrc` enforces it)
- Do not run `npm run dev`, `npm run build`, or `npm test`
- Target platform is **Windows** (see `01`, section "Windows notes")
