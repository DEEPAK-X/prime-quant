# 05 — Agent C: Windows spike, launch, docs, Pattern 3 daemon

You own:

- `packages/dsh-prime/README.md` (user-facing install)
- `packages/coding-agent/src/cli/gui-launch.ts` (and the CLI flag wiring that
  already calls `launchGui` — find the caller; do not refactor unrelated CLI)
- New docs under `packages/coding-agent/docs/` for DSH (one file)
- Root `package.json` **script additions only** (e.g. `gui:dsh`), no dependency
  churn without 7-day rule
- Pattern 3: `packages/dsh-prime/src/host/transport-daemon.ts` **after A
  lands the `PrimeTransport` interface** — or a sibling file A agreed in
  `dsh-contract:`
- Unreleased changelog bullets for launch/docs
- Optional: one nav hint in `packages/web-ui` **only after an issue**

Do not touch A’s mapper/pool/provider logic except the transport module.
Do not touch B’s client nodes.
Do not change daemon protocol schema, `DAEMON_PROTOCOL_VERSION`, or add
commands. Pattern 3 is **attach + existing prompt**, capability-negotiated.

Deliverable: DSH is runnable on this Windows checkout as an opt-in surface;
users learn how to install the plugin; later, a daemon transport so a running
TUI daemon can be reused instead of spawning RPC.

## Reference reading (this order)

1. `docs/dsh-adapter/01-overview-and-architecture.md`
2. `docs/dsh-adapter/02-frozen-contract.md` §2 spawn, §8 launch, §3 patch ids
3. `packages/coding-agent/src/cli/gui-launch.ts`
4. `packages/web-ui/server/preview-bridge.mjs` — Windows spawn / `--open`
5. `packages/coding-agent/docs/acp.md`
6. `packages/coding-agent/src/modes/daemon/daemon-client.ts`
7. `packages/coding-agent/src/cli/daemon-launch.ts` — how TUI finds the socket
8. `AGENTS.md` daemon section (capability gates, no new startup commands)
9. `PLAN.md` 8 GB / Windows constraints
10. DSH: `dsh --profile web --dump-config`, directory-picker Windows notes
    (native picker `koffi` failure → browse picker)

## Layout you create / edit

```
packages/dsh-prime/README.md          # NEW, user install
packages/coding-agent/docs/dsh.md     # NEW, developer
packages/coding-agent/src/cli/gui-launch.ts   # --surface
packages/dsh-prime/src/host/transport-daemon.ts  # Pattern 3 only, after A2/A3
```

Do **not** create `packages/dsh-prime/src/host/index.ts` (A). If you need an
overlay YAML for `--surface dsh` that sets `tool-subagent-prime.disabled: false`,
put it at `packages/dsh-prime/overlays/gui-dsh.yml` (you own `overlays/`).

## Phase 0 — Windows spike (do this first; it gates everyone)

Work on a feature branch but the spike **notes** go in `packages/coding-agent/docs/dsh.md`
as “Verified on …” facts. If DSH will not stay up, **stop Pattern 1–3 product
work** and write that in the doc; do not paper over it.

Commands (adjust if the pinned CLI differs):

```
node --version          # need >= 22.19 for DSH, repo wants >= 22.8
npx @deepseek-ai/dsh --version
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web --no-open
```

Record:

| Check | Result you must write down |
|---|---|
| Bind address | Must be 127.0.0.1, not 0.0.0.0 |
| Default port | 3080 or whatever printed |
| RSS of `dsh` node after idle 60 s | MB |
| Native directory picker | works / fails (`koffi`)? |
| Browse-picker workaround | exact `cordis.patch.yml` snippet if needed |
| Does dump-config show `dsh-subagent-acp`? | yes/no — A depends on this |
| Exact package names for subagent + tool-subagent | paste into a `dsh-contract:` issue if they differ from `02` §3 |

Windows spawn: if you invoke npx, use `process.execPath` + npx CLI js, not
`npx.cmd`. Spike in a terminal is allowed; **production launch code** must
follow `gui-launch.ts` rules (`windowsHide: true`).

Do not kill unrelated tmux/session processes. Do not leave `dsh web` running
as an always-on leftover when you finish; stop it.

**Acceptance:**

- [ ] `docs/dsh.md` contains the table filled with **measured** numbers, not
      guesses. Date the measurement.
- [ ] If DSH fails on Windows: the doc says FAIL and A/B are told. You still
      land the doc. You do not implement `--surface dsh` as if it worked.

## Milestone C1 — Plugin README

`packages/dsh-prime/README.md`:

- What it is (optional DSH profile plugin; Prime remains the brain)
- Prerequisites: Node, this monorepo, `dsh` pinned version from A’s
  package.json / your spike
- Install into web profile (folder add)
- Enable `tool-subagent-prime` (disabled by default)
- `dsh web`, add workspace = this repo
- Delegate a quant task via the model (example prompt)
- Native GUI still: `npm run gui:live` / `prime-agent gui`
- Windows notes: directory picker, 127.0.0.1, 8 GB (DSH + Prime + kernel
  only after first `subagent_prime`)
- Uninstall: `dsh plugin --profile web remove …`

No emoji. Technical prose. Do not duplicate the whole architecture of `01`.

**Acceptance:** a new clone could follow only this README + `docs/dsh.md`.

## Milestone C2 — `prime-agent gui --surface dsh`

Extend `LaunchGuiOptions`:

```ts
surface?: "native" | "dsh"; // default "native"
```

- `native` (default): current `preview-bridge.mjs` path. **Regression-test
  this.** Existing `/gui` slash command and `prime-agent gui` must not change
  behavior.
- `dsh`: resolve `packages/dsh-prime` the same walk-up style as
  `findPreviewBridge`. Fail fast if missing. Spawn DSH web with `--no-open`
  unless `options.open`. Pass overlay that enables `tool-subagent-prime` if
  A kept it disabled in git (`02` §3 / A6).
- Wire CLI args in the existing gui command parser (search `launchGui(` and
  `--open`). Add `--surface` next to it. Do not invent a second command.
- Optional root script: `"gui:dsh": "…"` only if it does not require
  `npm run dev`. Prefer `node` + a small orchestrator like preview-bridge.
  If you add `packages/web-ui/server/preview-dsh.mjs`, you own that file.

Windows: `windowsHide: true`, `process.execPath`, bind 127.0.0.1.

**Acceptance:**

- [ ] Unit test or pure function test: `parse surface`, find-plugin walk-up,
      missing plugin throws the documented error. Fake filesystem.
- [ ] Default `launchGui()` still returns `http://127.0.0.1:5173` (or
      current PORT). Do not break the Vite path.
- [ ] Manual Windows note in the PR: `--surface dsh` printed URL.

Do not run `npm run build`.

## Milestone C3 — Docs + changelog

- `packages/coding-agent/docs/dsh.md` — spike table, pin, overlay, RAM.
- Link from `packages/coding-agent/README.md` **only if** that README already
  has a docs index; otherwise link from `docs/dsh-adapter/README.md` (you may
  add one line there).
- Changelog Unreleased (coding-agent):  
  `Added optional \`prime-agent gui --surface dsh\` to open DeepSeek Harness with the Prime Quant plugin.`  
  Only after C2 is real.
- Do not edit released version sections.

## Milestone C4 — Pattern 3 daemon transport (blocked)

**Do not start C4 until A’s `PrimeTransport` interface is merged** (`03` A3).

Then implement `transport-daemon.ts`:

- Detect existing daemon socket the same way TUI does (`defaultDaemonSocketPath`
  / `DaemonClient`). Import from coding-agent public exports if available;
  if not exported, use `DaemonClient` via a path A/C agree — **do not copy
  the protocol types**.
- `hello` / capability negotiation. Need attach + prompt. If the daemon is
  older and lacks a capability you need, **fail attach** and let the pool
  stay on RPC. Do not bump `DAEMON_PROTOCOL_VERSION`.
- `ensure()`: connect, attach to a dedicated session id
  `dsh-prime` (create if API allows; else attach to active). Prefer a
  **new** session so the TUI user’s conversation is not clobbered. If create
  would require a new daemon command, **stop** and file `dsh-contract:` +
  daemon issue — use RPC fallback instead of overloading the TUI session.
- Subscribe daemon events → the same v2 mapping A already has, **or** feed
  records into A’s `EventTranslator` if daemon events match RPC session_event
  shapes. If they don’t, write a thin daemon→v2 adapter in **your** file and
  hand v2 to A’s `session-bridge`. Do not fork `translator.ts`.
- `abort` / `stop`: detach; do not shut down the daemon (TUI still owns it).
- DSH `apply()` still must not connect. First `start()` tries daemon, on
  failure logs one line and uses RPC pool (A’s transport).

Tests: fake socket or injected DaemonClient double. No live daemon in CI.

**Acceptance:**

- [ ] With no daemon, provider still RPC (A’s tests still pass).
- [ ] With a fake hello that omits required caps, attach fails closed.
- [ ] `stop()` does not send daemon shutdown.

## Milestone C5 — Optional native GUI hint

Only after an issue the owner accepts:

- A single line in the web-ui Settings placeholder: “Optional DSH surface:
  `prime-agent gui --surface dsh`”.
- You own that one-line edit. No new view.

Default: skip C5.

## Hard rules

- Never `git add -A`.
- Never add daemon commands to DSH or GUI startup.
- Never `mkdir` on `\\.\pipe\...`.
- Wrap directory fsync in try/catch if you fsync (you shouldn’t need to).
- JSON files: Node `writeFileSync(..., "utf8")`, no PowerShell `Set-Content`.
- 8 GB: document that Phase 1 ACP (fresh kernel per run) is **not** the
  product path; C’s README must say Phase 2 pooled RPC is required for
  acceptable RAM. If your spike shows idle DSH alone is already too large,
  say so — that is a product stop, not something A can code around.
- `npm run check` green.

## What “done” means for you (before integration)

Phase 0 doc with real numbers. README. `--surface dsh` behind a flag.
Pattern 3 either landed or explicitly deferred in `docs/dsh.md` with the
blocker named (missing PrimeTransport / cannot create isolated daemon
session). Native GUI default unchanged.
