# Windows Setup

## Prerequisites

- **Node.js >= 22.8.0** (matches the repo `engines` field). Required for `node --import tsx` and `--env-file` loader hooks used by the `server` and `gui` scripts. If you use the web GUI (`packages/web-ui`), >= 22.12.0 is recommended (its `engines` floor).
- **A bash shell** (see below). Git for Windows is sufficient and recommended.
- **MetaTrader 5 terminal** only if you use the live MT5 data skills (`rlm.quant.fetch_data`).

## Bash Shell

Prime Agent requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Web GUI

Launch the web GUI (Vite dev server + backend bridge) from the TUI with `/gui`, or from a shell with `prime-agent gui`. Both open the default browser automatically. The launch path is Windows-safe: it spawns `node` directly (no `npx` / `.cmd` shim) and the bridge binds `127.0.0.1` while the Vite proxy dials `127.0.0.1`, avoiding the `localhost`→`::1` (IPv6) mismatch that broke `/api` and `/ws` on Windows.

The GUI is a source-checkout-only feature — run it from the monorepo root (where `packages/web-ui` lives), not from an installed package.
