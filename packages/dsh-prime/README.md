# @prime-quant/dsh-prime

Optional [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) profile plugin that lets a DSH web
session delegate quant work — backtests, CPCV/DSR/PBO validation, MT5 data, tearsheets, `rlm.quant.*`
— to Prime Agent over pooled RPC. Prime Agent stays the brain: same prompts, tools, IPython kernel,
and session isolation as everywhere else. DSH is only another window onto it.

The default Prime Quant GUI is unchanged (`npm run gui:live` / `prime-agent gui`). Installing this
plugin does not affect the TUI, daemon, or native GUI; idle DSH spawns zero Prime processes and zero
kernels until a `subagent_prime` call.

## Prerequisites

- This monorepo checkout with `packages/coding-agent/dist/bundle/cli.js` built (the plugin spawns that
  bundle; see `packages/coding-agent/docs/development.md` for the build).
- Node >= 22.19 and pnpm on PATH (DSH manages profile plugins through pnpm).
- DeepSeek Harness, developer preview, pinned during testing to `@deepseek-ai/dsh` `0.1.1-rc.2`:

  ```
  npm install -g @deepseek-ai/dsh
  dsh --version
  ```

- Windows notes: DSH binds `127.0.0.1:3080` only; measured idle footprint is ~110 MB (see
  `packages/coding-agent/docs/dsh.md` for the spike numbers). Budget for DSH + browser + one Prime
  session + kernel; the kernel starts only on the first delegation.

## Install into the web profile

From the repo root:

```
dsh plugin --profile web add <absolute path to packages\dsh-prime>
```

This installs the package into `%USERPROFILE%\.dsh\profiles\web` and adds its patch rows
(`cordis.patch.yml`) to the profile layer stack. Row ids are frozen by
`docs/dsh-adapter/02-frozen-contract.md` §3:

| Row | What it does |
|---|---|
| `subagent-prime-rpc` | Registers subagent provider `prime` over pooled RPC (Phase 2 product path) |
| `prime-host-glue` | Registers the "delegate quant work" prompt section, `/prime-reports/*`, `/prime-status` |
| `tool-subagent-prime` | Exposes the `subagent_prime` tool to the model (**disabled by default**) |
| `subagent-prime-acp` | Legacy stock-ACP spike row (disabled; requires `@deepseek-ai/dsh-subagent-acp`) |

If the pinned DSH warns `declares no dsh.bundle — installed as a plain dependency, not a profile
layer`, the automatic layer reconciliation did not pick the package up. Working fallback until that
declaration ships: copy the rows from `packages/dsh-prime/cordis.patch.yml` into
`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` (keep the ids).

## Enable and use

1. Boot the surface from this checkout:

   ```
   prime-agent gui --surface dsh
   ```

   That resolves this checkout's plugin, enables `tool-subagent-prime` for the launch via
   `overlays/gui-dsh.yml`, starts `dsh web`, and prints `http://127.0.0.1:3080`. Plain
   `dsh web --no-open` also works after install; enable the tool yourself in DSH settings if you skip
   the launcher. The Vite native GUI stays the default: `prime-agent gui` without flags.

2. In the DSH UI, add workspace = this repo (`C:\...\<checkout>`). On Windows the picker uses the
   native folder dialog; if it misbehaves, the browse fallback picker covers it.

3. Delegate quant work through the model — the prompt section tells DSH's model that quant research
   belongs in `subagent_prime`:

   > Test this strategy on MT5 and give me the report.

   The first `subagent_prime` call starts the pooled Prime RPC child (one process, reused across
   runs); cards, pipeline steps, and tearsheet links render back into the DSH chat. Tearsheets are
   served read-only under `/prime-reports/…` from the session workspace.

4. Coding questions that don't need quant tooling stay inside DSH and never spawn Prime.

## Uninstall

```
dsh plugin --profile web remove @prime-quant/dsh-prime
```

Then delete any copied rows from the profile `cordis.patch.yml` if you used the fallback above.
Native GUI, TUI, and daemon are unaffected throughout.

## Layout

```
src/            host runtime (provider, pool, session bridge) — see docs/dsh-adapter/03
overlays/       launch overlays owned by the gui launcher (gui-dsh.yml)
client/         DSH client ConversationNodes — see docs/dsh-adapter/04
fixtures/       SessionEvent replay scripts for client tests
```

Further reading: `docs/dsh-adapter/01-overview-and-architecture.md`,
`packages/coding-agent/docs/dsh.md` (measured Windows facts), `packages/coding-agent/docs/rpc.md`.
