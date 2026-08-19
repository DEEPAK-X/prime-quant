# PRIME QUANT — Product Plan (two-agent execution)

Complete roadmap to turn this fork into the PRIME QUANT product: a Windows-first, 8 GB-RAM-friendly quant agent OS. Work is split between **Agent A (OpenHands, cloud)** and **Agent B (local agent)**. Both agents work in parallel on feature branches with small PRs into `main`.

## Hard constraints (no compromises)

1. **Zero intelligence compromise.** Model providers, prompts, and tools stay identical across OSes. All work is harness/UI/packaging — never downgrade models, prompts, or validation logic to fit the machine.
2. **8 GB RAM budget.** The GUI is a thin view onto the existing daemon; it never spawns kernels/agents itself. One shared Python kernel across agents (existing behavior — keep it). Virtualized lists, single WebSocket, no renderer state duplication. Cap live watcher agents at 3 by default.
3. **Windows is the primary target.** Every PR states its Windows verification steps. Bundle path (`dist/bundle/cli.js`) is the default user path; `tsx` is dev-only.
4. **Repo discipline.** `npm run check` clean before commit; touched test files must run and pass; one changelog bullet per user-visible change under `[Unreleased]`; obey the CRITICAL parallel-agent git rules (only commit your own files, never force-push, never reset/checkout others' work).

## Current state (verified 2026-08-19)

- `npm run check` clean; Python engine 148 passed / 1 skipped; bundle build works.
- Already shipped: Windows launchers, `tui:dist`, splash rebrand, expanded `docs/windows.md` (PR #9).
- Existing foundations to build on: `packages/web-ui` (React 19 + Vite + Tailwind: chat, sub-agent monitor, tearsheet viewer), `packages/web-ui-server` (WS bridge, MT5 health probe `mt5.ts`, tearsheets, RPC session), `/gui` slash command + `prime-agent gui` CLI command, daemon agent-messaging, `prime-agent schedule` (cron prompts), quant skill bundle (`rlm.quant.*`), AST lookahead linter, validation gate (CPCV + walk-forward + DSR/PBO), `recall_failures` memory loop.

## Workstream split

| Stream | Owner | Packages (primary file ownership) |
|---|---|---|
| **A — OS Shell & UX** | Agent A (OpenHands, cloud) | `packages/web-ui`, `packages/web-ui-server`, `packages/coding-agent/src/cli/gui-launch.ts`, root README, root docs |
| **B — Quant Core & Watchers** | Agent B (local) | `prime-quant/` (Python engine), `packages/coding-agent/skills/quant`, `packages/coding-agent/src/core/kernel/bootstrap.ts`, `.github/workflows` |

Collision protocol: both streams may append to `packages/coding-agent/CHANGELOG.md` — bullets only, never reorder; rebase, don't rewrite. Root `package.json` changes: Agent A owns script additions; Agent B must not edit it. Anything outside your column: open an issue note, don't edit.

## Milestones

### M0 — Windows launch (DONE, PR #9)
Launchers, bundle path, docs, splash rebrand. Owner: A. Status: in PR.

### M1 — OS shell (Agent A) ∥ Quant foundation (Agent B)

**A1. OS shell over `packages/web-ui`** — App frame: left rail (Dashboard, Agents, Rooms, Trading Bots, Training Room, Knowledge Base, Tasks, Logs, Settings), top status bar (LOCAL MODE, provider health, MT5 status via existing `mt5.ts` probe, kernel venv status, daemon status, RAM meter), right rail (agents online, mentions, shared files, pinned). Dark "command center" theme. Acceptance: renders against the existing `demo-backend.mjs`; `tsc --noEmit` clean; no new runtime processes; lists virtualized.

**B1. Non-MT5 data path** — `primequant.data.loader` gains broker-CSV/parquet ingestion to the same canonical OHLCV schema (frees the product from Windows-only MT5 dependency). Tests in `prime-quant/tests`.

**B2. Watcher skill presets** — quant-skill prompt templates for the three canonical watchers: Risk Watcher (drawdown/daily-loss alerts), Flow Watcher (volume/volatility anomalies via `fetch_data`), Research Watcher (validation-gated idea triage). Each preset is a schedule-able prompt + expected card outputs, documented in the skill README.

### M2 — Rooms & watcher runtime (Agent A) ∥ Bootstrap UX + CI (Agent B)

**A2. Rooms model in web-ui-server** — map daemon agent-messaging onto named rooms (default: `general`, `alerts`, `risk-management`, `research`, `system-updates`); GUIs subscribe per-room over the single WS; mentions surface when a message targets the user. Acceptance: two scheduled watcher agents post into rooms; `/gui` end-to-end on Windows documented.

**A3. Watcher presets pack UI** — one-click "spawn Risk Watcher" that calls `prime-agent schedule` with stream-B templates; watcher cards show last-run card output and next-run time.

**B3. Kernel bootstrap progress visibility** — surface bootstrap stages (uv install, CPython download, pip installs) in the TUI as a status line instead of silent worker logs; failures must print the log path. No behavior change to bootstrap order.

**B4. Windows CI smoke job** — GitHub Actions `windows-latest`: npm ci, build, `cli.js --version` + `--help` on the bundle, pytest engine suite. Fails the PR on regression.

### M3 — Product surfaces (both, on own files)

**A5. Trading Bots view** — bound to `rlm.quant.run_pipeline`: run history, validation gate verdicts, tearsheet library from `web-ui-server/src/tearsheets.ts`.

**A6. Training Room view** — Optuna runs as first-class objects (param spaces, trials, best-so-far, overfit verdicts).

**B5. Strategy template library** — 5 reference strategies (sma-cross, rsi-reversion, breakout, carry proxy, vol-scaled momentum) passing the AST linter + validation gate, each with a passing pytest and a one-line card example.

**B6. Tearsheet ↔ rooms wiring** — pipeline completion posts the tearsheet artifact link into `#research`.

### M4 — Distribution & identity

**A7. `install.ps1` Windows installer** (parity with `install.sh`): prebuilt bundle tarball, checksum-verified, `prime-quant` on PATH; no build step for end users. Owner A, with B4 CI producing the artifact.

**A8. Full rebrand decision gate** — config dir (`~/.prime/agent`), binary name, daemon socket: rename once with migration, at a versioned minor bump. Until then, only user-visible strings say PRIME QUANT.

**Docs site skeleton** (A) + MT5/CSV setup guides (B).

## Definition of done (every milestone)

- `npm run check` clean; all touched vitest/pytest files pass; changelog bullets added.
- PRs are small (one milestone item each), from feature branches, base `main`, with Windows verification notes.
- No new always-on background processes; memory budget respected (state it in the PR if near the edge).
- If a milestone item is blocked by the other stream, note it in the issue and pick the next item — never idle.

## First assignments

- **Agent A**: start with **A1 (OS shell)** on a branch off `main` once PR #9 lands.
- **Agent B**: start with **B1 (CSV/parquet loader)** + **B2 (watcher presets)** — both fully parallel-safe with A1.

---

_This plan was drafted by an AI agent (OpenHands) on behalf of the repository owner. It is the coordination doc for two parallel agents; treat the file-ownership table as binding to avoid merge conflicts._
