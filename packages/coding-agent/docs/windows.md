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

## Fast Startup (Recommended)

`npm run tui` is the development path: it runs the CLI through `tsx`, and the CLI, background daemon, session worker, and catalog process each transpile the full TypeScript monorepo independently. On machines with 8 GB RAM and real-time antivirus scanning this multiplies into minutes of apparent hanging on first launch.

Use the prebuilt bundle instead — every process then runs plain Node on already-compiled JavaScript:

```powershell
# from the repo root, one-time
npm install
npm run build

# every launch after that (works from any directory)
.\prime-quant.cmd
# or: powershell -ExecutionPolicy Bypass -File .\prime-quant.ps1
# or: npm run tui:dist   (repo root only)
```

`prime-quant.cmd` / `prime-quant.ps1` install dependencies and build the bundle automatically on first run, then always take the fast path. They run the agent in your current directory, like the released `prime-agent` binary.

Use a modern terminal: **Windows Terminal**, not legacy `conhost.exe`, so the TUI renders box-drawing/braille correctly.

## First Launch: Kernel Bootstrap

The first time a session starts, the Python kernel bootstrap runs in the background:

1. Installs `uv` (via PowerShell `irm https://astral.sh/uv/install.ps1 | iex`) if not present
2. Downloads a standalone CPython
3. Creates `~/.prime/agent/kernel-venv/` and installs ipykernel, polars, numpy, optuna, the repo-local `prime-quant` engine, and `MetaTrader5`

This is one-time and can take several minutes on a slow connection. The TUI is usable while it runs; IPython/quant tool calls wait for it. Watch progress in the newest file under `%USERPROFILE%\.prime\agent\logs\`. If the machine is offline or a package index is blocked, the bootstrap fails silently — check the logs, then delete `%USERPROFILE%\.prime\agent\kernel-venv` to force a rebuild.

## Antivirus / Defender

Windows Defender real-time scanning is the single biggest slowdown for Node development checkouts. Add exclusions (requires admin) for:

- The repo directory
- `%USERPROFILE%\.prime`
- `%LOCALAPPDATA%\uv` and `%USERPROFILE%\.local\bin` (uv and the managed CPython)

`Add-MpPreference -ExclusionPath <path>` in an elevated PowerShell.

## Troubleshooting "It Hangs"

1. Use the bundle path above, not `npm run tui`.
2. Check service state: `.\prime-quant.cmd status` and `.\prime-quant.cmd doctor` (add `--fix` to repair).
3. Read the newest log in `%USERPROFILE%\.prime\agent\logs\` — daemon, supervisor, and worker startup errors land there.
4. Reset background services: `.\prime-quant.cmd shutdown --force`, then start again.
5. Verify prerequisites: `node --version` must be >= 22.8.0, and Git Bash must be installed (see above).
6. If `npm install` resolves packages oddly, upgrade npm (`npm install -g npm@latest`): the repo's 7-day `min-release-age` supply-chain cooldown requires npm >= 11.10 to be enforced.
