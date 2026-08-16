/**
 * Preview entrypoint (Freebuff-managed dev server).
 *
 * Runs the demo quant backend (port 3001) and the Vite GUI dev server
 * (PORT env or 5173) as one supervised process tree:
 *
 *   - gui:     `vite --host 0.0.0.0 --port <PORT|5173>`  (proxy -> :3001)
 *   - backend: `node server/demo-backend.mjs`  (emulates the quant daemon)
 *
 * Vite is started first and the backend only spawns once the GUI answers on
 * its port, so the preview readiness probe resolves to the GUI, not the API.
 * Spawning via process.execPath avoids PATH issues inside the preview shell.
 * On exit of either child the whole tree is torn down.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guiPort = process.env.PORT ?? "5173";
const backendPort = process.env.QUANT_BACKEND_PORT ?? "3001";
// Deps are hoisted to the repo root in this monorepo; resolve vite through
// node's module lookup instead of assuming a local node_modules.
const require = createRequire(import.meta.url);
const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");

const children = [];

function run(name, command, args, env) {
	const child = spawn(command, args, {
		cwd: root,
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
run("backend", process.execPath, ["server/demo-backend.mjs"], { PORT: backendPort });
