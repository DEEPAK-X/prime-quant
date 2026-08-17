/**
 * Live preview entrypoint (npm run gui:live).
 *
 * Runs the real bridge (port 3001, spawns the agent RPC child) and the Vite
 * GUI dev server (PORT env or 5173) as one supervised process tree:
 *
 *   - gui:     `vite --host 0.0.0.0 --port <PORT|5173>`  (proxy -> :3001)
 *   - backend: `tsx packages/web-ui-server/src/main.ts`   (real bridge)
 *
 * Vite is started first and the bridge only spawns once the GUI answers on
 * its port, so the preview readiness probe resolves to the GUI, not the API.
 * Spawning via process.execPath avoids PATH issues inside the preview shell.
 * On exit of either child the whole tree is torn down.
 */
import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

// `--open` launches the default browser once the GUI is ready. Default off so
// `npm run gui:live` and CI harnesses keep their current headless behavior.
const openBrowser = process.argv.includes("--open");

// preview-bridge.mjs lives in packages/web-ui/server/; the repo root is two
// levels above packages/web-ui/, and the backend entry is resolved relative to
// the repo root (where the root `npm run server` script runs from).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..", "..");
const guiPort = process.env.PORT ?? "5173";
const backendPort = process.env.QUANT_BACKEND_PORT ?? "3001";
// Deps are hoisted to the repo root in this monorepo; resolve vite/tsx through
// node's module lookup instead of assuming a local node_modules.
const require = createRequire(import.meta.url);
const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const tsxCli = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

const children = [];

function run(name, command, args, env, cwd = root) {
	const child = spawn(command, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: "inherit",
	});
	children.push(child);
	child.on("exit", (code, signal) => {
		console.log(`[preview] ${name} exited (${signal ?? code})`);
		shutdown();
	});
	return child;
}

async function waitForHttp(url, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok || response.status < 500) return true;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

// Cross-platform default-browser launch. Mirrors the TUI's login-dialog openURL
// (no shell, no quoting) so it is Windows-safe via rundll32 url.dll,FileProtocolHandler.
function openUrl(url) {
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const [command, ...args] =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? [path.join(systemRoot, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", url]
				: ["xdg-open", url];
	try {
		execFile(command, args, () => {});
	} catch {
		// Best-effort: the GUI is still reachable at the printed URL.
	}
}

function shutdown() {
	for (const child of children) {
		if (child.exitCode === null) child.kill("SIGTERM");
	}
	setTimeout(() => {
		for (const child of children) {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		process.exit(0);
	}, 2000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

run("gui", process.execPath, [viteBin, "--host", "0.0.0.0", "--port", guiPort], {});
const guiUp = await waitForHttp(`http://127.0.0.1:${guiPort}`);
console.log(`[preview] gui ${guiUp ? "ready" : "failed"} on :${guiPort}`);
if (!guiUp) {
	process.exit(1);
}
run("backend", process.execPath, [tsxCli, "packages/web-ui-server/src/main.ts"], {
	QUANT_BACKEND_PORT: backendPort,
}, repoRoot);
const guiUrl = `http://127.0.0.1:${guiPort}`;
console.log(`[preview] open ${guiUrl}`);
if (openBrowser) openUrl(guiUrl);
