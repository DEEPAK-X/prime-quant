/**
 * Launches the PrimeQuant web GUI (Vite dev server + the real bridge) as a
 * supervised child tree and (optionally) opens the default browser.
 *
 * The GUI stack lives in `packages/web-ui` + `packages/web-ui-server` and is a
 * source-checkout-only feature (the `gui:live` npm script assumes a dev
 * monorepo layout). This command therefore resolves the orchestrator script
 * (`packages/web-ui/server/preview-bridge.mjs`) by walking up from the cwd
 * rather than via `import.meta.url`, so it works from any source worktree and
 * fails fast with a clear message when invoked from an installed bundle.
 *
 * Windows-safe: spawns `node` (process.execPath) with no shell, never `npx` (a
 * `.cmd` shim) or `sh`/`bash`. The bridge binds 127.0.0.1 and the Vite proxy
 * dials 127.0.0.1, avoiding the `localhost`→::1 IPv6/IPv4 mismatch.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const PREVIEW_BRIDGE_REL = ["packages", "web-ui", "server", "preview-bridge.mjs"];

/** Walk up from `start` looking for `<dir>/packages/web-ui/server/preview-bridge.mjs`. */
export function findPreviewBridge(start: string = process.cwd()): string | undefined {
	let dir = start;
	for (;;) {
		const candidate = resolve(dir, ...PREVIEW_BRIDGE_REL);
		if (existsSync(candidate)) return candidate;
		const parent = resolve(dir, "..");
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export interface LaunchGuiOptions {
	/** Open the default browser once the GUI is ready (default: true). */
	open?: boolean;
	/** Override the GUI port (defaults to the script's PORT env / 5173). */
	port?: string;
	/**
	 * stdio mode for the orchestrator. "inherit" for the standalone CLI command
	 * (the GUI logs stream to the caller's terminal); "ignore" for the TUI
	 * slash command (which owns the terminal and must not be clobbered).
	 */
	stdio?: "inherit" | "ignore";
}

export interface LaunchGuiResult {
	/** The process orchestrating the GUI + bridge. The caller owns its lifetime. */
	child: ChildProcess;
	/** The URL the GUI is served on. */
	url: string;
}

/**
 * Spawn the GUI preview orchestrator. Returns the child handle and the URL.
 * Throws if the GUI sources can't be located (e.g. running from an installed
 * bundle).
 */
export function launchGui(options: LaunchGuiOptions = {}): LaunchGuiResult {
	const script = findPreviewBridge();
	if (!script) {
		throw new Error(
			"The web GUI sources were not found. The GUI is a source-checkout-only feature: run `prime-agent gui` from the PrimeQuant monorepo (where packages/web-ui exists), not from an installed package.",
		);
	}

	const port = options.port ?? process.env.PORT ?? "5173";
	const stdio = options.stdio ?? "inherit";
	const args = [script, "--open"];
	if (options.open === false) args.splice(args.indexOf("--open"), 1);

	// Spawn node directly (no shell) so it works on Windows without a `.cmd`
	// shim. When stdio is "ignore" (TUI slash command), detach the child so the
	// GUI keeps running even after the TUI exits and does not touch the TUI's
	// terminal; the detached child gets its own process group.
	const detached = stdio === "ignore";
	const child = spawn(process.execPath, args, {
		stdio,
		detached,
		env: {
			...process.env,
			PORT: port,
		},
		windowsHide: true,
	});
	if (detached) child.unref();

	return { child, url: `http://127.0.0.1:${port}` };
}
