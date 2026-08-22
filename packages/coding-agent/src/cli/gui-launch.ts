/**
 * Launches a Prime Quant web surface as a supervised child tree.
 *
 * Two surfaces share this launcher:
 *
 * - `native` (default): the Vite GUI stack (`packages/web-ui` + `packages/web-ui-server`)
 *   orchestrated by `packages/web-ui/server/preview-bridge.mjs`.
 * - `dsh`: the optional DeepSeek Harness web UI (`@deepseek-ai/dsh web`) pointed at this
 *   checkout's plugin (`packages/dsh-prime`). See docs/dsh-adapter/02 §8 and
 *   packages/coding-agent/docs/dsh.md.
 *
 * Both are source-checkout-only features resolved by walking up from the cwd rather than via
 * `import.meta.url`, so they work from any source worktree and fail fast with a clear message
 * when invoked from an installed bundle.
 *
 * Windows-safe: spawns `node` (process.execPath) with no shell, never `npx` or a `.cmd` shim.
 * The native bridge binds 127.0.0.1 and the Vite proxy dials 127.0.0.1; DSH composes its
 * webserver to 127.0.0.1 by itself.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PREVIEW_BRIDGE_REL = ["packages", "web-ui", "server", "preview-bridge.mjs"] as const;
const DSH_PLUGIN_MARKER_REL = ["packages", "dsh-prime", "cordis.patch.yml"] as const;
const DSH_OVERLAY_REL = ["overlays", "gui-dsh.yml"] as const;
const DSH_PACKAGE_JS_REL = ["node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"] as const;
const TSX_LOADER_REL = ["node_modules", "tsx", "dist", "loader.mjs"] as const;

export const DEFAULT_DSH_PORT = "3080";

export const MISSING_PLUGIN_ERROR =
	"The DeepSeek Harness plugin was not found (expected packages/dsh-prime/cordis.patch.yml). " +
	"The DSH surface is a source-checkout-only feature: run `prime-agent gui --surface dsh` from the " +
	"PrimeQuant monorepo (where packages/dsh-prime exists), not from an installed package.";

export const MISSING_DSH_ERROR =
	"DeepSeek Harness (@deepseek-ai/dsh) was not found. Install it globally and retry: " +
	"`npm install -g @deepseek-ai/dsh`.";

/** Walk up from `start` looking for `<dir>/<...segments>`; returns the absolute hit or undefined. */
function walkUpFind(start: string, segments: readonly string[], exists: (path: string) => boolean): string | undefined {
	let dir = start;
	for (;;) {
		const candidate = resolve(dir, ...segments);
		if (exists(candidate)) return candidate;
		const parent = resolve(dir, "..");
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Walk up from `start` looking for `<dir>/packages/web-ui/server/preview-bridge.mjs`. */
export function findPreviewBridge(
	start: string = process.cwd(),
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	return walkUpFind(start, PREVIEW_BRIDGE_REL, exists);
}

/**
 * Walk up from `start` looking for `<dir>/packages/dsh-prime/cordis.patch.yml`, the marker that
 * the DSH plugin sources exist in this checkout. Returns the marker path.
 */
export function findDshPlugin(
	start: string = process.cwd(),
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	return walkUpFind(start, DSH_PLUGIN_MARKER_REL, exists);
}

/**
 * Locate the pinned DSH launcher JS to spawn with `process.execPath` (never a `.cmd` shim):
 * a local `node_modules` install first, then the global npm root (Windows `%APPDATA%\npm`,
 * POSIX `<exec-dir>/../lib/node_modules`).
 */
export function findDshLauncher(
	start: string = process.cwd(),
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	const local = walkUpFind(start, DSH_PACKAGE_JS_REL, exists);
	if (local) return local;
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming");
		const candidate = resolve(appData, "npm", ...DSH_PACKAGE_JS_REL);
		return exists(candidate) ? candidate : undefined;
	}
	const candidate = resolve(dirname(process.execPath), "..", "lib", ...DSH_PACKAGE_JS_REL);
	return exists(candidate) ? candidate : undefined;
}

export type SpawnGuiFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface LaunchGuiOptions {
	/** Open the default browser once the surface is ready (default: true). */
	open?: boolean;
	/** Override the port (native: Vite dev server / 5173; dsh: DSH webserver / 3080). */
	port?: string;
	/** Which web surface to launch (default: "native"). */
	surface?: "native" | "dsh";
	/**
	 * stdio mode for the orchestrator. "inherit" for the standalone CLI command
	 * (the logs stream to the caller's terminal); "ignore" for the TUI slash
	 * command (which owns the terminal and must not be clobbered).
	 */
	stdio?: "inherit" | "ignore";
	/** Start directory for checkout resolution (defaults to process.cwd()). */
	cwd?: string;
	/** Spawn override (tests inject a stub; production always uses node:child_process). */
	spawnFn?: SpawnGuiFn;
}

export interface LaunchGuiResult {
	/** The process orchestrating the surface. The caller owns its lifetime. */
	child: ChildProcess;
	/** The URL the surface is served on. */
	url: string;
}

interface SurfaceLaunchPlan {
	args: string[];
	env: NodeJS.ProcessEnv;
	url: string;
}

/** Plan the native Vite preview invocation (pure apart from the injected exists probe). */
function planNativeLaunch(options: LaunchGuiOptions, exists: (path: string) => boolean): SurfaceLaunchPlan {
	const script = findPreviewBridge(options.cwd, exists);
	if (!script) {
		throw new Error(
			"The web GUI sources were not found. The GUI is a source-checkout-only feature: run `prime-agent gui` from the PrimeQuant monorepo (where packages/web-ui exists), not from an installed package.",
		);
	}
	const port = options.port ?? process.env.PORT ?? "5173";
	const args = [script];
	if (options.open !== false) args.push("--open");
	return { args, env: { PORT: port }, url: `http://127.0.0.1:${port}` };
}

/**
 * Plan the DSH web invocation for this checkout's plugin (docs/dsh-adapter/02 §8).
 *
 * Overlays ride the launcher form, not the `web` alias: the pinned CLI passes
 * `web`'s remaining arguments to the web app itself, which rejects `--patch`.
 * So the argv is
 * `node [--import <tsx loader>] <dsh>/lib/bin.js --profile web [--patch <overlay>]... [app flags]`,
 * where the app flags are the same ones `dsh web` would take.
 *
 * The tsx ESM hook (repo devDependency, resolved by the same walk-up) lets the
 * pinned DSH host load this checkout's raw-TypeScript plugin entries; without
 * it Node's resolver demands compiled `.js`. The hook rides argv so spawned
 * Prime children stay clean.
 * Pure apart from the injected exists probe.
 */
export function planDshLaunch(options: LaunchGuiOptions, exists: (path: string) => boolean): SurfaceLaunchPlan {
	const pluginMarker = findDshPlugin(options.cwd, exists);
	if (!pluginMarker) {
		throw new Error(MISSING_PLUGIN_ERROR);
	}
	const binJs = findDshLauncher(options.cwd, exists);
	if (!binJs) {
		throw new Error(MISSING_DSH_ERROR);
	}
	const args: string[] = [];
	const tsxLoader = walkUpFind(options.cwd ?? process.cwd(), TSX_LOADER_REL, exists);
	if (tsxLoader) args.push("--import", pathToFileURL(tsxLoader).href);
	args.push(binJs, "--profile", "web");
	const overlay = resolve(dirname(pluginMarker), ...DSH_OVERLAY_REL);
	if (exists(overlay)) args.push("--patch", overlay);
	if (options.open === false) args.push("--no-open");
	const port = options.port ?? DEFAULT_DSH_PORT;
	args.push("--port", port);
	return { args, env: {}, url: `http://127.0.0.1:${port}` };
}

/**
 * Spawn the selected web surface orchestrator. Returns the child handle and the URL.
 * Throws if the requested surface can't be located (e.g. running from an installed bundle).
 */
export function launchGui(options: LaunchGuiOptions = {}): LaunchGuiResult {
	const plan = options.surface === "dsh" ? planDshLaunch(options, existsSync) : planNativeLaunch(options, existsSync);

	// Spawn node directly (no shell) so it works on Windows without a `.cmd` shim. When stdio
	// is "ignore" (TUI slash command), detach the child so the surface keeps running even after
	// the TUI exits and does not touch the TUI's terminal; the detached child gets its own
	// process group.
	const stdio = options.stdio ?? "inherit";
	const detached = stdio === "ignore";
	const spawnFn = options.spawnFn ?? spawn;
	const child = spawnFn(process.execPath, plan.args, {
		stdio,
		detached,
		env: {
			...process.env,
			...plan.env,
		},
		windowsHide: true,
	} satisfies SpawnOptions);
	if (detached) child.unref();

	return { child, url: plan.url };
}
