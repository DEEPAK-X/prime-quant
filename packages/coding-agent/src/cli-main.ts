import { enableCompileCache } from "node:module";
import { maybeStartDaemonEarly } from "./cli/daemon-launch.js";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess,
	maybeRunOwnedSessionWorkerFrontend,
} from "./cli/owned-session-worker.js";
import { hasNonInteractiveStartupFlag, startStartupProgress, stopStartupProgress } from "./cli/startup-progress.js";
import { APP_NAME } from "./config.js";

export async function runCli(): Promise<void> {
	try {
		enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}

	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	installOwnedSessionWorkerOwnerWatch();

	const args = process.argv.slice(2);
	const handledByOwnedWorker = await maybeRunOwnedSessionWorkerFrontend(args);
	if (!handledByOwnedWorker) {
		if (!isOwnedSessionWorkerProcess()) {
			startStartupProgress("Starting up...", args);
			// Boot a cold daemon concurrently with this process's heavy imports.
			maybeStartDaemonEarly(process.argv.slice(2));
		}
		const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { main }] = await Promise.all([
			import("undici"),
			import("./main.js"),
		]);

		// undici's 300s body/headers timeouts abort long local-LLM SSE stalls; provider
		// SDKs enforce their own deadlines via retry.provider.timeoutMs.
		setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

		try {
			await main(process.argv.slice(2));
		} catch (error) {
			// Startup failures used to surface only on stderr, which some Windows
			// terminal hosts (npm run under PowerShell) do not attach to the
			// console, so a failed boot looked like a silent hang. Mirror the
			// failure to stdout for interactive launches.
			const message = error instanceof Error ? error.message : String(error);
			const report = `Prime Agent failed to start: ${message}`;
			console.error(report);
			if (process.stdout.isTTY && !hasNonInteractiveStartupFlag(process.argv.slice(2))) {
				process.stdout.write(`${report}\n`);
			}
			process.exit(1);
		} finally {
			stopStartupProgress();
			closeOwnedSessionWorkerOwnerWatch();
		}
	}
}
