# DeepSeek Harness (DSH) — optional web surface

Developer notes for running Prime Quant behind [DeepSeek Harness](https://github.com/deepseek-ai) as an
opt-in alternative web UI. The default `prime-agent gui` remains the Vite native GUI; nothing in this
file changes that. Architecture and contracts live in `docs/dsh-adapter/` (start at its `README.md`).
User install steps live in `packages/dsh-prime/README.md`.

## Spike — measured on Windows

Verified 2026-08-22 on this checkout's machine, DSH installed globally via npm. All numbers below are
measured, not estimated.

| Check | Result |
|---|---|
| Pinned version | `@deepseek-ai/dsh` `0.1.1-rc.2` (developer preview, rc); all bundled `@deepseek-ai/*` profile packages at `0.1.1-rc.2` |
| Global layout | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`, shims `dsh.cmd` / `dsh.ps1` / `dsh` in `%APPDATA%\npm` |
| Node | v24.x (DSH needs >= 22.19; repo wants >= 22.8 — satisfied) |
| Bind address | `127.0.0.1` (measured via `netstat -ano` on a fresh boot; also the composed default: `host: ctx.webStartup.host ?? '127.0.0.1'`) |
| Default port | `3080` (composed default `port: ctx.webStartup.port ?? 3080`; confirmed by the long-running instance listening on `127.0.0.1:3080`) |
| Web flags | `--host <host>`, `--port <port>` (`0` = OS-picked), `--no-open`, `--trusted-host <authority...>`, `-h` |
| Idle RSS after 60 s | Working set **107.5 MB**, private **113.4 MB**, stable across samples, zero Prime processes, zero kernels (isolated boot, stock web profile, no browser attached). Long-running instance under active use: ~149 MB working set |
| Launcher writes | Every invocation (including `--dump-config` and `web --help`) composes and rewrites `<profile>/cordis.yml` under `$DSH_HOME`. Sandboxed/locked-down environments must allow `$DSH_HOME` writes or point `DSH_HOME` at a writable path |
| Telemetry switch | `DSH_TELEMETRY_DISABLED=1` hard-disables the `session-telemetry-otel` row (any non-empty value counts) |
| Directory picker | Web profile mounts `@deepseek-ai/dsh-host-directory-picker-auto`. On win32 + loopback bind + no SSH it resolves to the **native** backend (koffi Win32 IFileDialog driven from a spawned dialog worker); koffi is present in the profile tree. Browse fallback exists as separate packages (`dsh-host-directory-picker-browse` + client-ui variants). Workspaces were added through this UI on this machine (`%USERPROFILE%\.dsh\storages\workspace.json`) |
| Verdict | **PASS** — DSH boots and serves on Windows; no product stop |

## What the stock web profile contains

`--profile web --dump-config` (pinned version) shows the bundle layers `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app` and their rows. Facts that matter to the adapter:

- Subagent core is present: `@deepseek-ai/dsh-subagent`, with stock providers
  `subagent-spawn-in-process` / `subagent-fork-in-process`.
- The tool row package matches the contract: `@deepseek-ai/dsh-tool-subagent`
  (stock rows `tool-subagent` / `tool-subagent-fork` use it, disabled by default).
- **`@deepseek-ai/dsh-subagent-acp` is NOT part of the stock web profile** — it exists on npm
  (`0.0.1-rc.1`) as an optional plugin and must be added explicitly
  (`dsh plugin --profile web add @deepseek-ai/dsh-subagent-acp`). Not a rename; contract ids in
  `docs/dsh-adapter/02-frozen-contract.md` §3 stay valid.
- Webserver binds loopback by default and rejects nothing else by config; keep it that way.

## Plugin mechanics (verified against the pinned launcher)

- Profiles live under `%USERPROFILE%\.dsh\profiles\<name>` (`$DSH_HOME/profiles`). A profile is a pnpm
  workspace whose `package.json` lists bundle packages under `dsh.profile.bundles`; each bundle's own
  patch layer is applied in order, then the profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`,
  then any `--patch <path>` overlays (repeatable).
- `dsh plugin --profile web add <abs-path-or-pkg>` forwards to `pnpm add` inside the profile directory,
  then reconciles `dsh.profile.bundles`: **a dependency joins the layer stack only if its package.json
  declares `dsh.bundle.patch`**. Without that declaration it installs as a plain dependency and every
  boot warns `declares no dsh.bundle — installed as a plain dependency, not a profile layer`.
  - Gap (Agent A): `packages/dsh-prime/package.json` does not yet declare `dsh.bundle.patch`
    (e.g. `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`). Until it lands, the README's manual
    fallback (copying the rows into the profile user layer) is the working install path.
- `dsh plugin --profile web remove <pkg>` uninstalls and reconciles the layer list back out.
- Overlays are id-targeted patch entries, so enabling the disabled tool row for one launch is:

  ```yaml
  # overlays/gui-dsh.yml
  - id: tool-subagent-prime
    disabled: false
  ```

## Launch integration (this repo)

```
prime-agent gui                 # Vite native GUI (unchanged default)
prime-agent gui --surface dsh   # spawns dsh web for this checkout's plugin
npm run gui:dsh                 # same, via tsx source CLI
```

`--surface dsh` resolves the plugin (`packages/dsh-prime/cordis.patch.yml`) by walking up from the cwd,
fails fast with an actionable message when DSH or the plugin is missing, applies
`overlays/gui-dsh.yml` when present, and spawns `node <global>/@deepseek-ai/dsh/lib/bin.js web`
(never a `.cmd` shim) with `windowsHide: true`. `--no-open` unless `--open`-style opt-in;
`--port` passes through (default stays DSH's 3080).

## Pattern 3 status (daemon transport)

- Agent A's `PrimeTransport` interface is merged (`packages/dsh-prime/src/dsh-types.ts`,
  implemented by the RPC pool).
- `packages/dsh-prime/src/host/transport-daemon.ts` implements it over the existing daemon protocol:
  connect to `defaultDaemonSocketPath()`, verify protocol version, require the negotiated
  `client_owned_sessions` server capability, create + attach a dedicated client-owned session named
  `dsh-prime`, drive prompts through existing `prompt` / `abort` commands, and translate daemon
  `session_event` agent events into the same v2 events A's session bridge already consumes.
- No new daemon commands, no schema or version bump. `stop()` detaches and closes the client socket;
  it never sends `shutdown` (the TUI owns the daemon). If attach fails for any reason, the caller
  falls back to the RPC pool.
- Wiring the daemon-first choice into the host `apply()` touches Agent A's files and is left to A
  (one-line pool swap behind the existing interface).
- Dependency note (Agent A): `transport-daemon.ts` imports `DaemonClient` /
  `DAEMON_PROTOCOL_VERSION` / `defaultDaemonSocketPath` from the public
  `@earendil-works/pi-coding-agent` entry. That package resolves in this monorepo (root hoisting +
  root tsconfig paths) but is not declared in `packages/dsh-prime/package.json` yet; A should add
  `"@earendil-works/pi-coding-agent": "*"` to `dependencies` when wiring the transport in.

## RAM guidance

Measured idle DSH is ~110 MB. Budget for the full product path: DSH (~110–150 MB) + browser tab +
Prime RPC child + Python kernel, where the kernel starts only on the first `subagent_prime` call.
Phase 1-style ACP (fresh process per run) is not the product path precisely because of kernel cold
starts; the pooled Phase 2 RPC transport is required for acceptable RAM. On an 8 GB machine keep MT5
terminal + browser + DSH + one Prime session; treat 16 GB as comfortable.
