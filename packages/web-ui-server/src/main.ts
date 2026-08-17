/**
 * Bridge composition root (docs/gui-wiring/03 §M5).
 *
 * Wires the RPC agent session, tearsheet watcher, artifact scanner, MT5 probe,
 * and the v2 GUI bridge into one process bound to `127.0.0.1:3001`. Run with
 * `npm run server` (tsx) or `npm run gui:live` (via preview-bridge.mjs).
 *
 * Single source of truth: every v2 event — translated RPC events, tearsheet
 * updates, artifacts, cards — flows through the bridge's `emit`, which updates
 * the in-memory store and broadcasts to `/ws` clients.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { V2Event } from "./events.js";
import { createV2GuiBridge, DEFAULT_HOST, DEFAULT_PORT } from "./gui-bridge.js";
import { createMt5Probe } from "./mt5.js";
import { RpcSession } from "./rpc-session.js";
import { createArtifactScanner, createTearsheetWatcher, sniffCard } from "./tearsheets.js";
import type { CardSniffer } from "./translator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// The bridge is local-only: bind 127.0.0.1 explicitly, never 0.0.0.0.
const host = DEFAULT_HOST;
const port = Number(process.env.QUANT_BACKEND_PORT ?? DEFAULT_PORT);
const sessionId = "gui-session";

const log = (message: string) => console.log(`[bridge] ${message}`);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

try {
	// Late-bound: the watcher/scanner are wired before the bridge exists, so
	// their emissions are forwarded through this once the bridge is created.
	let emit: (event: V2Event) => void = () => {};

	const watcher = createTearsheetWatcher({
		root: repoRoot,
		onUpdate: (entry) => emit({ type: "tearsheet", url: entry.url, name: entry.name, ts: entry.ts }),
	});
	const scanner = createArtifactScanner({ root: repoRoot });

	// Card payloads carry `report.report_path`; register those on the watcher
	// so tearsheets that fs.watch misses still surface.
	const cardSniffer: CardSniffer = (text) => {
		const result = sniffCard(text);
		if (result) {
			const report = result.payload.report;
			if (isRecord(report) && typeof report.report_path === "string") {
				const reportPath = path.isAbsolute(report.report_path)
					? report.report_path
					: path.join(repoRoot, report.report_path);
				watcher.registerPath(reportPath);
			}
		}
		return result;
	};

	const session = new RpcSession({
		repoRoot,
		sessionDir: path.join(repoRoot, "packages", "web-ui-server", ".gui-sessions"),
		cardSniffer,
		log,
		rawRecordObserver: (record) => {
			if (record.type === "tool_execution_start" && record.toolName === "ipython") {
				scanner.beforeExecution();
			}
			if (record.type === "tool_execution_end" && record.toolName === "ipython") {
				for (const entry of scanner.afterExecution()) {
					emit({ type: "artifact", kind: entry.kind, name: entry.name, content: entry.content });
				}
			}
		},
	});

	const bridge = createV2GuiBridge({
		port,
		host,
		session: {
			prompt: (message) => session.prompt(message),
			interrupt: () => session.interrupt(),
			getAgentState: () => session.getAgentState(),
		},
		mt5: createMt5Probe({ log }),
		sessionId,
		artifactsRoot: repoRoot,
		log,
	});
	emit = (event) => bridge.emit(event);
	session.subscribe((event) => bridge.emit(event));

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		log("shutting down");
		await session.stop().catch(() => {});
		watcher.stop();
		await bridge.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	await bridge.start();
	log(`listening on http://${host}:${port} (session ${sessionId})`);
	watcher.start();
	await session.start();
	log("agent ready");
} catch (error) {
	log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
